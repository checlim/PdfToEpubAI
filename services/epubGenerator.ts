import JSZip from 'jszip';
import { marked } from 'marked';
import { ProcessedImage } from './imageProcessor';

// Helper to create a unique ID
const uuid = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// Helper to escape XML characters for attributes and text content
const escapeXml = (unsafe: string | null | undefined): string => {
  if (!unsafe) return '';
  return unsafe.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

// Native helper to download a Blob without external dependencies
const saveBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
};

interface TocItem {
  id: string;
  text: string;
  level: number;
}

export const generateEpub = async (title: string, markdownContent: string, images: ProcessedImage[] = []) => {
  const zip = new JSZip();
  const uniqueId = uuid();
  const timestamp = new Date().toISOString().split('.')[0] + 'Z';
  const cleanTitle = escapeXml(title); // Escape title for XML usage

  // Check for cover image (Page 1, Index 1)
  const coverFilename = 'image_p1_i1.jpg';
  const hasCover = images.some(img => img.name === coverFilename);

  // --- 1. PREPARE CONTENT & TOC ---
  
  const toc: TocItem[] = [];
  let headerCount = 0;

  const renderer = new marked.Renderer();

  // Custom renderer to capture headings for TOC and inject IDs
  // NOTE: In marked v12+, renderer methods receive a single object argument.
  // We use a regular function here to access `this.parser`.
  // @ts-ignore
  renderer.heading = function({ tokens, depth }: { tokens: any[], depth: number }) {
    // Parse the inline tokens to get the HTML content of the heading
    const text = this.parser.parseInline(tokens);
    const id = `section-${headerCount++}`;
    
    // Only add H1 and H2 to TOC to keep it clean
    if (depth <= 2) {
      // Strip any HTML tags from the text for the TOC (e.g. if title has <em>)
      const plainText = text.replace(/<[^>]*>?/gm, '');
      toc.push({ id, text: plainText, level: depth });
    }
    
    return `<h${depth} id="${id}">${text}</h${depth}>\n`;
  };

  // Custom renderer to fix image paths and ESCAPE ATTRIBUTES
  // @ts-ignore
  renderer.image = ({ href, title, text }: { href: string, title: string | null, text: string }) => {
    if (!href) return '';
    const cleanHref = href.startsWith('images/') ? href : `images/${href}`;
    const safeHref = escapeXml(cleanHref);
    const safeAlt = escapeXml(text);
    return `<img src="${safeHref}" alt="${safeAlt}" />`;
  };

  // Custom renderer for links to escape ampersands in URLs
  // @ts-ignore
  renderer.link = function({ href, title, tokens }: { href: string, title: string | null, tokens: any[] }) {
    const text = this.parser.parseInline(tokens);
    const safeHref = escapeXml(href);
    const safeTitle = title ? ` title="${escapeXml(title)}"` : '';
    return `<a href="${safeHref}"${safeTitle}>${text}</a>`;
  };

  renderer.hr = () => {
    return '<hr />\n';
  };

  renderer.br = () => {
    return '<br />';
  };

  const contentHtmlBody = await marked.parse(markdownContent, { 
    renderer
  });

  // --- 2. FILE STRUCTURE SETUP ---

  // 2a. Mimetype
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  // 2b. Container XML
  zip.folder("META-INF")?.file("container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
   <rootfiles>
      <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
   </rootfiles>
</container>`);

  const oebps = zip.folder("OEBPS");
  if (!oebps) throw new Error("Failed to create zip folder");

  // --- 3. CSS ---
  const css = `
    body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; line-height: 1.6; padding: 20px; }
    h1 { color: #2c3e50; page-break-before: always; text-align: center; margin-top: 2em; margin-bottom: 1em; }
    h2 { color: #34495e; margin-top: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.5em; }
    p { margin-bottom: 1em; text-align: justify; }
    blockquote { border-left: 4px solid #3498db; padding-left: 1em; color: #7f8c8d; font-style: italic; margin: 1.5em 0; }
    img { max-width: 100%; height: auto; display: block; margin: 20px auto; border-radius: 4px; }
    figure { margin: 1em 0; text-align: center; }
    figcaption { font-size: 0.8em; color: #7f8c8d; margin-top: 0.5em; }
    nav#toc { margin-bottom: 2em; }
    nav#toc ol { list-style-type: none; padding-left: 0; }
    nav#toc li { margin-bottom: 0.5em; }
    nav#toc a { text-decoration: none; color: #2980b9; }
  `;
  oebps.file("styles.css", css);

  // --- 4. NAVIGATION DOCUMENTS ---

  const navLiItems = toc.map(item => 
    `<li${item.level === 2 ? ' style="padding-left:20px;"' : ''}><a href="content.xhtml#${item.id}">${escapeXml(item.text)}</a></li>`
  ).join('\n');

  const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${cleanTitle}</title>
  <link rel="stylesheet" type="text/css" href="styles.css" />
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
      ${navLiItems || '<li><a href="content.xhtml">Begin Reading</a></li>'}
    </ol>
  </nav>
</body>
</html>`;
  oebps.file("nav.xhtml", navXhtml);

  const navPoints = toc.map((item, index) => `
    <navPoint id="navPoint-${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${escapeXml(item.text)}</text></navLabel>
      <content src="content.xhtml#${item.id}"/>
    </navPoint>
  `).join('\n');

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uniqueId}"/>
    <meta name="dtb:depth" content="2"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${cleanTitle}</text></docTitle>
  <navMap>
    ${navPoints || `<navPoint id="navPoint-1" playOrder="1"><navLabel><text>Start</text></navLabel><content src="content.xhtml"/></navPoint>`}
  </navMap>
</ncx>`;
  oebps.file("toc.ncx", tocNcx);

  // --- 5. COVER XHTML ---
  // Create a separate cover page file if a cover image exists
  if (hasCover) {
     const coverXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Cover</title>
  <style type="text/css">
    body { margin: 0; padding: 0; text-align: center; }
    div.cover { height: 100vh; display: flex; align-items: center; justify-content: center; }
    img { max-width: 100%; height: 100%; object-fit: contain; }
  </style>
</head>
<body>
  <div class="cover">
    <img src="images/${coverFilename}" alt="Cover Image" />
  </div>
</body>
</html>`;
    oebps.file("cover.xhtml", coverXhtml);
  }

  // --- 6. CONTENT XHTML ---
  const contentXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${cleanTitle}</title>
  <link rel="stylesheet" type="text/css" href="styles.css" />
</head>
<body>
  ${contentHtmlBody}
</body>
</html>`;
  oebps.file("content.xhtml", contentXhtml);

  // --- 7. IMAGES & MANIFEST CONSTRUCTION ---
  const imagesFolder = oebps.folder("images");
  let imageManifestItems = "";
  
  if (imagesFolder) {
      images.forEach(img => {
          imagesFolder.file(img.name, img.data);
          
          let id = img.name.replace(/\./g, '_');
          let properties = "";
          
          // Special handling for the cover image
          if (img.name === coverFilename) {
              id = "cover-image";
              properties = ' properties="cover-image"';
          }
          
          imageManifestItems += `<item id="${id}" href="images/${img.name}" media-type="${img.mimeType}"${properties}/>\n`;
      });
  }

  // Manifest item for the cover XHTML page itself
  const coverManifestItem = hasCover 
    ? `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>` 
    : '';

  // --- 8. CONTENT.OPF (Manifest) ---
  const opfContent = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${cleanTitle}</dc:title>
    <dc:creator>MagToEpub AI</dc:creator>
    <dc:identifier id="BookID">urn:uuid:${uniqueId}</dc:identifier>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${timestamp}</meta>
    ${hasCover ? '<meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    ${coverManifestItem}
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="styles" href="styles.css" media-type="text/css"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
    ${imageManifestItems}
  </manifest>
  <spine toc="ncx">
    ${hasCover ? '<itemref idref="cover" linear="yes"/>' : ''}
    <itemref idref="nav" />
    <itemref idref="content"/>
  </spine>
  <guide>
    ${hasCover ? '<reference type="cover" title="Cover" href="cover.xhtml" />' : ''}
    <reference type="toc" title="Table of Contents" href="nav.xhtml" />
    <reference type="text" title="Start" href="content.xhtml" />
  </guide>
</package>`;

  oebps.file("content.opf", opfContent);

  // Generate binary and save
  const content = await zip.generateAsync({ type: "blob" });
  saveBlob(content, `${title}.epub`);
};