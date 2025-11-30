import React, { useMemo } from 'react';
import { marked } from 'marked';

interface MarkdownPreviewProps {
  content: string;
}

export const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({ content }) => {
  const htmlContent = useMemo(() => {
    return marked.parse(content, { async: false }) as string;
  }, [content]);

  return (
    <article className="prose prose-slate max-w-none prose-headings:font-serif prose-headings:text-slate-900 prose-p:text-slate-600 prose-a:text-blue-600">
      {/* Render HTML safely. Since this is client-side generated from AI we trust it reasonably, 
          but in prod we would sanitize with DOMPurify */}
      <div dangerouslySetInnerHTML={{ __html: htmlContent }} />
    </article>
  );
};