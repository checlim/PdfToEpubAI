import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { ProcessedImage, blobToBase64 } from "./imageProcessor";

const getClient = () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) throw new Error("API_KEY not found in environment");
    return new GoogleGenAI({ apiKey });
}

// Helper: Wait for specified milliseconds
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Retry operation with exponential backoff for rate limit errors
async function retryWithBackoff<T>(
    fn: () => Promise<T>, 
    retries = 5, 
    currentDelay = 2000,
    onRetry?: (delay: number) => void
): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        // Check for 429 or quota related errors
        const isRateLimit = err.status === 429 || 
                            err.code === 429 || 
                            err.message?.includes('429') || 
                            err.message?.toLowerCase().includes('quota') ||
                            err.message?.toLowerCase().includes('resource_exhausted');

        if (retries > 0 && isRateLimit) {
            console.warn(`Rate limit exceeded. Retrying in ${currentDelay}ms... (${retries} attempts left)`);
            if (onRetry) onRetry(currentDelay);
            await delay(currentDelay);
            return retryWithBackoff(fn, retries - 1, currentDelay * 2, onRetry);
        }
        throw err;
    }
}

/**
 * Batches images and uses Gemini Vision to generate semantic descriptions.
 * This "labels" the images so the text generation step knows what they are.
 */
export const generateImageCaptions = async (
    images: ProcessedImage[], 
    onProgress?: (count: number) => void,
    onTokenUsage?: (tokens: number) => void
): Promise<ProcessedImage[]> => {
    const ai = getClient();
    // Using Flash Lite for captioning to save quota on the main model.
    // It is fast, cheap, and has higher rate limits, perfect for simple description tasks.
    const modelId = 'gemini-flash-lite-latest';

    // We only process images that aren't the cover (p1_i1)
    const contentImages = images.filter(img => img.name !== 'image_p1_i1.jpg');
    
    // Batch size for captioning
    const BATCH_SIZE = 8;
    const captionedImages = [...images]; // Start with clone

    for (let i = 0; i < contentImages.length; i += BATCH_SIZE) {
        const batch = contentImages.slice(i, i + BATCH_SIZE);
        
        // Prepare parts: Text prompt + Image parts
        const parts: any[] = [{ 
            text: `Analyze these ${batch.length} magazine images. 
            Return a JSON ARRAY where each object has 'name' (filename) and 'description' (short descriptive alt text).
            Example: [{"name": "image_p2_i1.jpg", "description": "Portrait of the author smiling"}]` 
        }];

        for (const img of batch) {
            const b64 = await blobToBase64(img.data);
            parts.push({
                inlineData: { mimeType: img.mimeType, data: b64 }
            });
            // We append the filename as text to help the model associate index to name if needed
            parts.push({ text: `Filename: ${img.name}` });
        }

        try {
            // Use retry mechanism for API calls
            const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
                model: modelId,
                contents: { parts },
                config: { 
                    responseMimeType: 'application/json' 
                }
            }));

            // Track Usage
            if (response.usageMetadata && onTokenUsage) {
                onTokenUsage(response.usageMetadata.totalTokenCount || 0);
            }

            const resultText = response.text;
            if (resultText) {
                const json = JSON.parse(resultText);
                if (Array.isArray(json)) {
                    json.forEach((item: any) => {
                        const targetIndex = captionedImages.findIndex(img => img.name === item.name);
                        if (targetIndex !== -1) {
                            captionedImages[targetIndex].description = item.description;
                        }
                    });
                }
            }
            
            // Proactive delay to prevent hitting RPM limits between batches
            await delay(1000);

        } catch (e) {
            console.warn("Failed to generate captions for batch", e);
        }

        if (onProgress) onProgress(i + batch.length);
    }

    return captionedImages;
};

export const convertPagesToMarkdown = async (
    base64Images: string[], 
    imageInventory: ProcessedImage[] = [],
    onRetry?: (delay: number) => void
) => {
    const ai = getClient();
    
    // Using Standard Flash for high quality text extraction and layout understanding
    const modelId = 'gemini-2.5-flash'; 
    
    // Create a text representation of the available images and their descriptions
    const inventoryText = imageInventory.map(img => 
        `- ${img.name}: "${img.description || 'No description available'}"`
    ).join('\n');

    const prompt = `
    You are an expert digital publisher and accessibility specialist.
    Convert the provided magazine pages into clean, structured Markdown suitable for conversion to an EPUB ebook.
    
    I have provided ${base64Images.length} images representing consecutive pages of a magazine.
    
    Rules:
    1. SEQUENCE (CRITICAL): 
       - Process the pages strictly in the order provided.
       - Output the full text content. Do not summarize.

    2. TEXT REFINEMENT (CRITICAL):
       - DE-HYPHENATION: You MUST fix words split across lines. 
         - Example: If you see "Stan- ford" or "un- believable" due to a line break, output "Stanford" and "unbelievable".
         - Remove the hyphen and the newline/space between the parts.
       - CLEANUP: Remove running headers, footers, and page numbers.
       - ADS: Do not include advertisement content.
       - OMISSIONS:
         - Do NOT transcribe the magazine's original "Table of Contents" or "Index" pages.
         - Do NOT transcribe "Masthead" or "Credits" sections.
         - If a page contains ONLY these ignored elements, output nothing for that page (except the PAGE_BREAK).

    3. PROGRESS TRACKING (CRITICAL):
       - At the very end of the content for EACH physical page, you MUST insert the following marker on a new line:
         <!-- PAGE_BREAK -->

    4. Structure & Hierarchy (CRITICAL FOR TOC): 
       - H1 (#): Use ONLY for the Main Article Title (once per article).
       - H2 (##): Use ONLY for distinct structural sections (e.g., "Introduction", "The Early Years").
       - Q&A / INTERVIEWS: Do NOT use Headers (# or ##) for interview questions. Use **Bold Text** instead.
       - Do NOT use headers for paragraphs or pull quotes.
       - Use > for Pull Quotes.
       - Note: Any line starting with # or ## will appear in the Table of Contents. Keep it clean.

    5. IMAGES (SMART PLACEMENT):
       - I have extracted specific images from these pages. Here is the INVENTORY of available files and their content:
       
       ${inventoryText || 'No images extracted for this section.'}

       - Your Task: As you read the text, if you encounter visual content (a photo, a chart, an illustration) that MATCHES a description in the inventory, insert the image tag.
       - Syntax: ![Alt Text](filename)
       - Logic: 
         - If the text describes a "Chart of Revenue", and the inventory has 'image_p5_i1.jpg': "Bar chart showing revenue", LINK IT.
         - If you see an image on the page but it is NOT in the inventory (it might have been too small/blurry and was filtered out), DO NOT invent a filename. Skip it.
       - Placement: Insert the image tag EXACTLY where it belongs contextually (e.g., between paragraphs discussing the image).
       
       - EXCEPTION: Do NOT insert "image_p1_i1.jpg". This is the cover.

    6. Output:
       - Return ONLY the markdown.
    `;

    // Construct the parts: Text prompt + Image parts
    const parts: any[] = [{ text: prompt }];
    
    base64Images.forEach(base64 => {
        parts.push({
            inlineData: {
                mimeType: 'image/jpeg',
                data: base64
            }
        });
    });

    // Use retry mechanism for stream initiation
    return await retryWithBackoff<AsyncIterable<GenerateContentResponse>>(
        () => ai.models.generateContentStream({
            model: modelId,
            contents: {
                parts: parts
            },
        }),
        5,    // retries
        2000, // initial delay
        onRetry // callback
    );
};