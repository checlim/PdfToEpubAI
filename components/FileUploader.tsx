import React, { useRef, useState } from 'react';
import { UploadCloud, File as FileIcon } from 'lucide-react';

interface FileUploaderProps {
  onFileSelect: (file: File) => void;
}

export const FileUploader: React.FC<FileUploaderProps> = ({ onFileSelect }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type === 'application/pdf') {
      onFileSelect(files[0]);
    } else {
        alert("Please upload a valid PDF file.");
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFileSelect(e.target.files[0]);
    }
  };

  return (
    <div 
      onClick={() => inputRef.current?.click()}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        relative group cursor-pointer rounded-2xl border-2 border-dashed transition-all duration-300 w-full h-64 flex flex-col items-center justify-center
        ${isDragging 
            ? 'border-blue-500 bg-blue-50 scale-[1.02]' 
            : 'border-slate-300 hover:border-blue-400 hover:bg-slate-50 bg-white'
        }
      `}
    >
      <input 
        type="file" 
        accept="application/pdf" 
        className="hidden" 
        ref={inputRef} 
        onChange={handleChange}
      />
      
      <div className="p-4 bg-blue-50 text-blue-600 rounded-full mb-4 group-hover:scale-110 transition-transform duration-300">
        <UploadCloud size={32} />
      </div>
      
      <h3 className="text-xl font-semibold text-slate-700 mb-2">Click to upload or drag and drop</h3>
      <p className="text-slate-500 text-sm max-w-xs text-center">
        Support for PDF Magazines. Max size recommended 20MB.
      </p>
      
      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-500/10 rounded-2xl backdrop-blur-[1px]">
             <div className="bg-white px-6 py-3 rounded-full shadow-lg text-blue-600 font-bold flex items-center gap-2">
                <FileIcon size={20} /> Drop PDF Here
             </div>
        </div>
      )}
    </div>
  );
};