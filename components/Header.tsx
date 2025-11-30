import React from 'react';
import { Book } from 'lucide-react';

export const Header: React.FC = () => {
  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2 text-blue-600">
          <Book className="w-6 h-6" />
          <span className="font-bold text-xl tracking-tight text-slate-900">MagToEpub<span className="text-blue-600">AI</span></span>
        </div>
        <a 
            href="https://ai.google.dev/" 
            target="_blank" 
            rel="noreferrer"
            className="text-xs font-medium text-slate-500 hover:text-blue-600 transition-colors"
        >
            Powered by Gemini
        </a>
      </div>
    </header>
  );
};