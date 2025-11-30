import * as pdfjsLib from 'pdfjs-dist';

// Configure worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://aistudiocdn.com/pdfjs-dist@^4.0.379/build/pdf.worker.min.mjs`;

export interface ProcessedImage {
  name: string;
  data: Blob;
  mimeType: string;
  description?: string; // AI Generated description
}

export interface ImageExtractionResult {
  images: ProcessedImage[];
  totalPages: number;
}

/**
 * Utility to convert Blob to Base64 string
 */
export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        // Remove data URL prefix (e.g., "data:image/jpeg;base64,")
        resolve(reader.result.split(',')[1]); 
      } else {
        reject(new Error('Failed to convert blob to base64'));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

/**
 * Loads the PDF document once to be reused across operations.
 * This prevents expensive re-parsing of the file.
 */
export const loadPdfDocument = async (file: File) => {
    const arrayBuffer = await file.arrayBuffer();
    return await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
};

/**
 * intelligently groups pages into batches based on text density.
 * Text-heavy pages get smaller batches to avoid output token limits.
 * Image-heavy/sparse pages get larger batches for speed.
 */
export const calculateDynamicBatches = async (pdf: any): Promise<number[][]> => {
    const numPages = pdf.numPages;
    const batches: number[][] = [];
    
    // Heuristic Configuration
    const MAX_CHARS_PER_BATCH = 12000; // Approx 2000-2500 words (Safe limit for output)
    const MAX_PAGES_PER_BATCH = 8;     // Limit context window for images
    
    let currentBatch: number[] = [];
    let currentBatchChars = 0;

    for (let i = 1; i <= numPages; i++) {
        let pageTextLength = 0;
        
        try {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            // Sum up the length of all strings on the page
            pageTextLength = textContent.items.reduce((acc: number, item: any) => acc + item.str.length, 0);
            page.cleanup(); // Free memory
        } catch (e) {
            console.warn(`Could not analyze text density for page ${i}, assuming average.`, e);
            pageTextLength = 1000; // Fallback assumption
        }

        // Check if adding this page would exceed limits
        const isTextFull = (currentBatchChars + pageTextLength) > MAX_CHARS_PER_BATCH;
        const isPagesFull = currentBatch.length >= MAX_PAGES_PER_BATCH;

        if ((isTextFull || isPagesFull) && currentBatch.length > 0) {
            // Push current batch and start a new one
            batches.push(currentBatch);
            currentBatch = [i];
            currentBatchChars = pageTextLength;
        } else {
            // Add to current batch
            currentBatch.push(i);
            currentBatchChars += pageTextLength;
        }
    }

    // Push the final batch
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
};

/**
 * Extracts images from PDF pages, resizes them, and compresses them to JPEG.
 * Optimized for performance using parallel processing and shared PDF instance.
 */
export const extractAndProcessImages = async (
  pdf: any, // pdfjsLib.PDFDocumentProxy
  onProgress?: (percentage: number, msg: string) => void
): Promise<ImageExtractionResult> => {
  
  const processedImages: ProcessedImage[] = [];
  const numPages = pdf.numPages;

  // We process pages in chunks to avoid blocking the main thread too long
  // while still gaining speed from concurrency.
  const CONCURRENCY = 4;
  
  // Track processed count for progress updates
  let processedCount = 0;

  // Helper to process a single page
  const processPage = async (pageNum: number) => {
    // Create a dedicated canvas for this task to avoid race conditions if we were sharing one
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    try {
        const page = await pdf.getPage(pageNum);

        // --- SPECIAL HANDLING FOR COVER (PAGE 1) ---
        if (pageNum === 1) {
            const viewport = page.getViewport({ scale: 2.0 });
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;
            
            const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
            if (blob) {
                processedImages.push({ name: 'image_p1_i1.jpg', data: blob, mimeType: 'image/jpeg', description: 'Magazine Cover' });
            }
            page.cleanup();
            return;
        }

        const operatorList = await page.getOperatorList();
        let imageIndex = 1;

        for (let i = 0; i < operatorList.fnArray.length; i++) {
            const fn = operatorList.fnArray[i];
            if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject) {
                const imgName = operatorList.argsArray[i][0];
                try {
                    const imgObj = await page.objs.get(imgName);
                    if (!imgObj) continue;

                    const width = imgObj.width || (imgObj.bitmap ? imgObj.bitmap.width : 0);
                    const height = imgObj.height || (imgObj.bitmap ? imgObj.bitmap.height : 0);
                    
                    // Filter out small icons, lines, or noise (Increased to 200px)
                    if (width < 200 || height < 200) continue;

                    const MAX_WIDTH = 1000;
                    let newWidth = width;
                    let newHeight = height;
                    if (width > MAX_WIDTH) {
                        const ratio = MAX_WIDTH / width;
                        newWidth = MAX_WIDTH;
                        newHeight = height * ratio;
                    }

                    canvas.width = newWidth;
                    canvas.height = newHeight;
                    
                    if (imgObj.bitmap) {
                        ctx.drawImage(imgObj.bitmap, 0, 0, newWidth, newHeight);
                    } else if (imgObj instanceof ImageBitmap || imgObj instanceof HTMLImageElement || imgObj instanceof HTMLCanvasElement) {
                        // @ts-ignore
                        ctx.drawImage(imgObj, 0, 0, newWidth, newHeight);
                    } else {
                        continue;
                    }

                    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.80));
                    if (blob) {
                        processedImages.push({ name: `image_p${pageNum}_i${imageIndex}.jpg`, data: blob, mimeType: 'image/jpeg' });
                        imageIndex++;
                    }
                } catch (err) { }
            }
        }
        page.cleanup();
    } catch (pageErr) {
        console.warn(`Error processing page ${pageNum}`, pageErr);
    }
  };

  // Execute in batches
  for (let i = 1; i <= numPages; i += CONCURRENCY) {
      const batchPromises = [];
      for (let j = 0; j < CONCURRENCY && (i + j) <= numPages; j++) {
          batchPromises.push(processPage(i + j));
      }
      
      await Promise.all(batchPromises);
      
      processedCount += batchPromises.length;
      if (onProgress) {
          const percent = Math.round((processedCount / numPages) * 100);
          onProgress(percent, `Scanning page ${processedCount} of ${numPages}...`);
      }
  }

  // Sort images to ensure they are in order (since Promises might resolve out of order)
  processedImages.sort((a, b) => {
      // Extract page number from filename "image_pX_iY.jpg"
      const getPage = (name: string) => parseInt(name.split('_p')[1].split('_')[0]);
      const getIndex = (name: string) => parseInt(name.split('_i')[1].split('.')[0]);
      
      const pA = getPage(a.name);
      const pB = getPage(b.name);
      if (pA !== pB) return pA - pB;
      return getIndex(a.name) - getIndex(b.name);
  });

  return {
    images: processedImages,
    totalPages: numPages
  };
};

/**
 * Renders specific pages to Base64 JPEG strings for AI processing.
 * Uses the existing PDF document instance for speed.
 */
export const renderPages = async (pdf: any, pageNumbers: number[]): Promise<string[]> => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    if (!ctx) throw new Error("Could not initialize canvas");

    const base64Images: string[] = [];

    // Process sequentially to ensure order in the output array matches input pageNumbers
    for (const pageNum of pageNumbers) {
        if (pageNum > pdf.numPages) continue;

        try {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.5 });
            
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            
            await page.render({
                canvasContext: ctx,
                viewport: viewport
            }).promise;
            
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            const base64 = dataUrl.split(',')[1];
            base64Images.push(base64);
            
            page.cleanup();
        } catch (e) {
            console.error(`Failed to render page ${pageNum} for AI`, e);
        }
    }

    return base64Images;
};