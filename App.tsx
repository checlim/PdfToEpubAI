import React, { useState, useCallback, useRef, useEffect } from 'react';
import { FileUploader } from './components/FileUploader';
import { MarkdownPreview } from './components/MarkdownPreview';
import { Header } from './components/Header';
import { convertPagesToMarkdown, generateImageCaptions } from './services/gemini';
import { generateEpub } from './services/epubGenerator';
import { extractAndProcessImages, renderPages, loadPdfDocument, calculateDynamicBatches, ProcessedImage } from './services/imageProcessor';
import { AlertCircle, Loader2, FileText, Download, BookOpen, Image as ImageIcon, ScanEye, Database } from 'lucide-react';

export default function App() {
  const [status, setStatus] = useState<'idle' | 'extracting_images' | 'analyzing_images' | 'generating_text' | 'complete' | 'error'>('idle');
  const [markdown, setMarkdown] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [loadingMessage, setLoadingMessage] = useState<string>('');
  const [progress, setProgress] = useState<number>(0);
  const [extractedImages, setExtractedImages] = useState<ProcessedImage[]>([]);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [tokenUsage, setTokenUsage] = useState<number>(0);
  
  // Ref for auto-scrolling the streaming text
  const streamLogRef = useRef<HTMLDivElement>(null);

  // Auto-scroll effect
  useEffect(() => {
    if (streamLogRef.current) {
      streamLogRef.current.scrollTop = streamLogRef.current.scrollHeight;
    }
  }, [markdown]);

  const handleFileSelect = useCallback(async (file: File) => {
    setStatus('extracting_images');
    setMarkdown('');
    setErrorMessage('');
    setExtractedImages([]);
    setProgress(0);
    setTotalPages(0);
    setTokenUsage(0);
    setFileName(file.name.replace(/\.[^/.]+$/, ""));

    try {
      // 0. Load PDF Document Once
      setLoadingMessage("Loading document structure...");
      const pdfDoc = await loadPdfDocument(file);
      const detectedPages = pdfDoc.numPages;
      setTotalPages(detectedPages);

      // 1. Extract Images
      let images: ProcessedImage[] = [];
      try {
        const result = await extractAndProcessImages(pdfDoc, (percent, msg) => {
            setProgress(percent);
            setLoadingMessage(msg);
        });
        images = result.images;
        console.log(`Extracted ${images.length} images`);
      } catch (imgErr) {
        console.error("Image extraction warning:", imgErr);
      }

      // 2. Analyze Images (Generate Captions)
      if (images.length > 0) {
        setStatus('analyzing_images');
        setProgress(0);
        setLoadingMessage('AI is labeling extracted images...');
        try {
            images = await generateImageCaptions(
                images, 
                (count) => {
                    const percent = Math.round((count / images.length) * 100);
                    setProgress(percent);
                    setLoadingMessage(`Labeled ${count} of ${images.length} images...`);
                },
                (tokens) => {
                    setTokenUsage(prev => prev + tokens);
                }
            );
        } catch (capErr) {
            console.warn("Image captioning failed, proceeding with unlabeled images", capErr);
        }
      }
      setExtractedImages(images);

      // 3. Convert Text with Gemini (DYNAMIC BATCHED)
      setStatus('generating_text');
      setLoadingMessage('Optimizing reading flow...');
      setProgress(0); 
      
      let processedPagesCount = 0;

      try {
        // Calculate optimal batches based on text density
        const batches = await calculateDynamicBatches(pdfDoc);
        console.log(`Planned ${batches.length} processing batches`, batches);

        for (let i = 0; i < batches.length; i++) {
            const batchPageNumbers = batches[i];
            const batchStart = batchPageNumbers[0];
            const batchEnd = batchPageNumbers[batchPageNumbers.length - 1];

            setLoadingMessage(`Analyzing pages ${batchStart} to ${batchEnd} of ${detectedPages}...`);

            // 3a. Render pages to visual data using the EXISTING PDF doc
            const batchVisuals = await renderPages(pdfDoc, batchPageNumbers);

            // 3b. Filter inventory for this batch to give context to AI
            const batchInventory = images.filter(img => {
                const match = img.name.match(/image_p(\d+)_/);
                if (match) {
                    const imgPage = parseInt(match[1]);
                    return imgPage >= batchStart && imgPage <= batchEnd;
                }
                return false;
            });

            // 3c. Send to Gemini
            const stream = await convertPagesToMarkdown(
                batchVisuals, 
                batchInventory,
                (delayMs) => {
                   setLoadingMessage(`Rate limit hit. Pausing for ${delayMs/1000}s to refill quota...`);
                }
            );
            
            let batchTokenCount = 0;
            for await (const chunk of stream) {
                const text = chunk.text;
                if (text) {
                    setMarkdown(prev => prev + text);
                }
                if (chunk.usageMetadata?.totalTokenCount) {
                    batchTokenCount = chunk.usageMetadata.totalTokenCount;
                }
            }
            // Update token stats with the final count from this batch
            if (batchTokenCount > 0) {
                setTokenUsage(prev => prev + batchTokenCount);
            }
            
            // Add a visual separator
            setMarkdown(prev => prev + "\n\n");

            // Update progress
            processedPagesCount += batchPageNumbers.length;
            const currentPercent = Math.round((processedPagesCount / detectedPages) * 100);
            setProgress(currentPercent);

            // Proactive pause between batches to prevent rate limiting (429)
            // Increased to 5s to be safe
            if (i < batches.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        
        setStatus('complete');

      } catch (err: any) {
        console.error("Gemini API Error:", err);
        setStatus('error');
        setErrorMessage(err.message || "Failed to process PDF with AI.");
      }

    } catch (err: any) {
      console.error(err);
      setStatus('error');
      setErrorMessage("An unexpected error occurred: " + (err.message || "Unknown error"));
    }
  }, []);

  const handleDownloadEpub = async () => {
    if (!markdown) return;
    try {
      await generateEpub(fileName || 'magazine', markdown, extractedImages);
    } catch (e) {
      console.error(e);
      alert("Failed to generate EPUB file.");
    }
  };

  const reset = () => {
    setStatus('idle');
    setMarkdown('');
    setFileName('');
    setExtractedImages([]);
    setProgress(0);
    setTotalPages(0);
    setTokenUsage(0);
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <Header />
      
      <main className="flex-grow container mx-auto px-4 py-8 max-w-5xl">
        
        {/* Error Banner */}
        {status === 'error' && (
          <div className="mb-6 bg-red-50 border-l-4 border-red-500 p-4 rounded-r shadow-sm flex items-start gap-3">
             <AlertCircle className="w-5 h-5 text-red-500 mt-0.5" />
             <div>
               <h3 className="font-bold text-red-800">Conversion Failed</h3>
               <p className="text-sm text-red-700">{errorMessage}</p>
               <button onClick={reset} className="mt-2 text-sm font-semibold text-red-800 hover:underline">Try Again</button>
             </div>
          </div>
        )}

        {/* Upload Section */}
        {status === 'idle' && (
          <div className="max-w-2xl mx-auto mt-12">
            <div className="text-center mb-10">
              <h2 className="text-4xl font-bold text-slate-900 mb-4 tracking-tight">Transform PDFs into Reading Experiences</h2>
              <p className="text-lg text-slate-600">Upload a PDF magazine. Gemini AI will read it, extract content, and we'll optimize images for a beautiful EPUB.</p>
            </div>
            <FileUploader onFileSelect={handleFileSelect} />
            
            <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6 text-center">
                <div className="p-4">
                    <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-3">
                        <FileText size={24} />
                    </div>
                    <h3 className="font-semibold text-slate-800">Smart OCR</h3>
                    <p className="text-sm text-slate-500 mt-1">Extracts text and layout intelligently using Gemini 2.5 Flash.</p>
                </div>
                <div className="p-4">
                    <div className="w-12 h-12 bg-purple-100 text-purple-600 rounded-full flex items-center justify-center mx-auto mb-3">
                        <ScanEye size={24} />
                    </div>
                    <h3 className="font-semibold text-slate-800">Visual Understanding</h3>
                    <p className="text-sm text-slate-500 mt-1">AI analyzes and labels images to ensure correct placement.</p>
                </div>
                 <div className="p-4">
                    <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3">
                        <Download size={24} />
                    </div>
                    <h3 className="font-semibold text-slate-800">Local Processing</h3>
                    <p className="text-sm text-slate-500 mt-1">Images are processed in your browser. Text sent securely to AI.</p>
                </div>
            </div>
          </div>
        )}

        {/* Processing Section */}
        {(status === 'extracting_images' || status === 'analyzing_images' || status === 'generating_text') && (
          <div className="flex flex-col items-center justify-center py-24">
            <div className="relative">
                <div className="absolute inset-0 bg-blue-500/20 rounded-full animate-ping"></div>
                <div className="relative bg-white p-4 rounded-full shadow-xl">
                    <Loader2 className="w-12 h-12 text-blue-600 animate-spin" />
                </div>
            </div>
            
            <h3 className="mt-8 text-2xl font-semibold text-slate-800">
                {status === 'extracting_images' ? 'Scanning PDF...' : 
                 status === 'analyzing_images' ? 'Analyzing Visuals...' : 'Creating EPUB Content...'}
            </h3>
            <p className="text-slate-500 mt-2 font-medium">{loadingMessage}</p>
            
            {/* Progress Bar Container */}
            <div className="w-80 mt-6">
                <div className="relative pt-1">
                    <div className="flex mb-2 items-center justify-between">
                        <div>
                            <span className="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full text-blue-600 bg-blue-200">
                                {status === 'extracting_images' ? 'Step 1/3' : 
                                 status === 'analyzing_images' ? 'Step 2/3' : 'Step 3/3'}
                            </span>
                        </div>
                        <div className="text-right">
                            <span className="text-xs font-semibold inline-block text-blue-600">
                                {progress}%
                            </span>
                        </div>
                    </div>
                    <div className="overflow-hidden h-2 mb-4 text-xs flex rounded bg-blue-200">
                        <div style={{ width: `${progress}%` }} className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-blue-500 transition-all duration-300 ease-out"></div>
                    </div>
                </div>
            </div>

            {/* Live Streaming Terminal (Only visible during text generation) */}
            {status === 'generating_text' && (
                <div 
                    ref={streamLogRef}
                    className="mt-8 p-4 bg-slate-900 rounded-lg border border-slate-800 shadow-inner max-w-2xl w-full h-80 overflow-y-auto font-mono text-xs text-green-400 scroll-smooth"
                >
                    <div className="whitespace-pre-wrap">
                        {markdown || "Waiting for stream..."}
                        <span className="animate-pulse inline-block w-2 h-4 bg-green-400 ml-1 align-middle"></span>
                    </div>
                </div>
            )}
          </div>
        )}

        {/* Results Section */}
        {status === 'complete' && (
          <div className="flex flex-col h-full">
             <div className="flex items-center justify-between mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-slate-900">Conversion Complete</h2>
                    <p className="text-slate-500">Review the extracted content before downloading.</p>
                </div>
                <div className="flex gap-3">
                    <button onClick={reset} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg font-medium transition-colors">
                        Convert Another
                    </button>
                    <button 
                        onClick={handleDownloadEpub}
                        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-semibold shadow-md transition-all hover:scale-105 active:scale-95"
                    >
                        <Download size={18} />
                        Download EPUB
                    </button>
                </div>
             </div>

             <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col md:flex-row h-[600px]">
                <div className="flex-1 overflow-auto p-8 bg-white">
                    <MarkdownPreview content={markdown} />
                </div>
                <div className="w-full md:w-80 bg-slate-50 border-l border-slate-200 p-6 flex flex-col gap-4 overflow-auto">
                     <h3 className="font-semibold text-slate-700 text-sm uppercase tracking-wider">Statistics</h3>
                     <div className="space-y-3">
                        <div className="bg-white p-3 rounded border border-slate-200">
                            <span className="text-xs text-slate-400 block">Total Pages</span>
                            <span className="text-lg font-medium text-slate-800">{totalPages}</span>
                        </div>
                        <div className="bg-white p-3 rounded border border-slate-200">
                            <span className="text-xs text-slate-400 block">Estimated Read Time</span>
                            <span className="text-lg font-medium text-slate-800">{Math.ceil(markdown.split(' ').length / 200)} min</span>
                        </div>
                        <div className="bg-white p-3 rounded border border-slate-200">
                            <span className="text-xs text-slate-400 block">Word Count</span>
                            <span className="text-lg font-medium text-slate-800">{markdown.split(' ').length.toLocaleString()}</span>
                        </div>
                        <div className="bg-white p-3 rounded border border-slate-200">
                            <span className="text-xs text-slate-400 block">Images Extracted</span>
                            <span className="text-lg font-medium text-slate-800">{extractedImages.length}</span>
                        </div>
                        {/* Token Usage Card */}
                        <div className="bg-blue-50 p-3 rounded border border-blue-200">
                            <div className="flex items-center gap-2 mb-1">
                                <Database size={12} className="text-blue-500" />
                                <span className="text-xs text-blue-600 font-semibold">AI Token Usage</span>
                            </div>
                            <span className="text-lg font-medium text-slate-800">{tokenUsage.toLocaleString()}</span>
                            <p className="text-[10px] text-blue-400 mt-1">Total input/output tokens</p>
                        </div>
                     </div>
                </div>
             </div>
          </div>
        )}

      </main>
    </div>
  );
}