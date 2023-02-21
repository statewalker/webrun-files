// https://docs.w3cub.com/http/basics_of_http/mime_types/complete_list_of_mime_types
export const mimeTypes = [
  { "extensions": ["aac"], "mime": "audio/aac", "description": "AAC audio" },
  { "extensions": ["abw"], "mime": "application/x-abiword", "description": "AbiWord document" },
  { "extensions": ["arc"], "mime": "application/x-freearc", "description": "Archive document (multiple files embedded)" },
  { "extensions": ["avi"], "mime": "video/x-msvideo", "description": "AVI: Audio Video Interleave" },
  { "extensions": ["azw"], "mime": "application/vnd.amazon.ebook", "description": "Amazon Kindle eBook format" },
  { "extensions": ["bin"], "mime": "application/octet-stream", "description": "Any kind of binary data" },
  { "extensions": ["bmp"], "mime": "image/bmp", "description": "Windows OS/2 Bitmap Graphics" },
  { "extensions": ["bz"], "mime": "application/x-bzip", "description": "BZip archive" },
  { "extensions": ["bz2"], "mime": "application/x-bzip2", "description": "BZip2 archive" },
  { "extensions": ["csh"], "mime": "application/x-csh", "description": "C-Shell script" },
  { "extensions": ["css"], "mime": "text/css", "description": "Cascading Style Sheets (CSS)" },
  { "extensions": ["csv"], "mime": "text/csv", "description": "Comma-separated values (CSV)" },
  { "extensions": ["doc"], "mime": "application/msword", "description": "Microsoft Word" },
  { "extensions": ["docx"], "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "description": "Microsoft Word (OpenXML)" },
  { "extensions": ["eot"], "mime": "application/vnd.ms-fontobject", "description": "MS Embedded OpenType fonts" },
  { "extensions": ["epub"], "mime": "application/epub+zip", "description": "Electronic publication (EPUB)" },
  { "extensions": ["gz"], "mime": "application/gzip", "description": "GZip Compressed Archive" },
  { "extensions": ["gif"], "mime": "image/gif", "description": "Graphics Interchange Format (GIF)" },
  { "extensions": ["htm", "html"], "mime": "text/html", "description": "HyperText Markup Language (HTML)" },
  { "extensions": ["ico"], "mime": "image/vnd.microsoft.icon", "description": "Icon format" },
  { "extensions": ["ics"], "mime": "text/calendar", "description": "iCalendar format" },
  { "extensions": ["jar"], "mime": "application/java-archive", "description": "Java Archive (JAR)" },
  { "extensions": ["jpg", "jpeg"], "mime": "image/jpeg", "description": "JPEG images" },
  { "extensions": ["js"], "mime": "text/javascript", "description": "JavaScript per the following specifications: https://html.spec.whatwg.org/multipage/#scriptingLanguages, https://html.spec.whatwg.org/multipage/#dependencies:willful-violation, https://datatracker.ietf.org/doc/draft-ietf-dispatch-javascript-mjs/" },
  { "extensions": ["json"], "mime": "application/json", "description": "JSON format" },
  { "extensions": ["jsonld"], "mime": "application/ld+json", "description": "JSON-LD format" },
  { "extensions": ["mid", "midi"], "mime": "application/ld+json", "description": "Musical Instrument Digital Interface (MIDI)	audio/midi audio/x-midi" },
  { "extensions": ["mjs"], "mime": "text/javascript", "description": "JavaScript module" },
  { "extensions": ["mp3"], "mime": "audio/mpeg", "description": "MP3 audio" },
  { "extensions": ["md"], "mime": "text/markdown", "description": "Markdown" },
  { "extensions": ["mpeg"], "mime": "video/mpeg", "description": "MPEG Video" },
  { "extensions": ["mpkg"], "mime": "application/vnd.apple.installer+xml", "description": "Apple Installer Package" },
  { "extensions": ["odp"], "mime": "application/vnd.oasis.opendocument.presentation", "description": "OpenDocument presentation document" },
  { "extensions": ["ods"], "mime": "application/vnd.oasis.opendocument.spreadsheet", "description": "OpenDocument spreadsheet document" },
  { "extensions": ["odt"], "mime": "application/vnd.oasis.opendocument.text", "description": "OpenDocument text document" },
  { "extensions": ["oga"], "mime": "audio/ogg", "description": "OGG audio" },
  { "extensions": ["ogv"], "mime": "video/ogg", "description": "OGG video" },
  { "extensions": ["ogx"], "mime": "application/ogg", "description": "OGG" },
  { "extensions": ["opus"], "mime": "audio/opus", "description": "Opus audio" },
  { "extensions": ["otf"], "mime": "font/otf", "description": "OpenType font" },
  { "extensions": ["png"], "mime": "image/png", "description": "Portable Network Graphics" },
  { "extensions": ["pdf"], "mime": "application/pdf", "description": "Adobe Portable Document Format (PDF)" },
  { "extensions": ["php"], "mime": "application/x-httpd-php", "description": "Hypertext Preprocessor (Personal Home Page)" },
  { "extensions": ["ppt"], "mime": "application/vnd.ms-powerpoint", "description": "Microsoft PowerPoint" },
  { "extensions": ["pptx"], "mime": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "description": "Microsoft PowerPoint (OpenXML)" },
  { "extensions": ["rar"], "mime": "application/vnd.rar", "description": "RAR archive" },
  { "extensions": ["rtf"], "mime": "application/rtf", "description": "Rich Text Format (RTF)" },
  { "extensions": ["sh"], "mime": "application/x-sh", "description": "Bourne shell script" },
  { "extensions": ["svg"], "mime": "image/svg+xml", "description": "Scalable Vector Graphics (SVG)" },
  { "extensions": ["swf"], "mime": "application/x-shockwave-flash", "description": "Small web format (SWF) or Adobe Flash document" },
  { "extensions": ["tar"], "mime": "application/x-tar", "description": "Tape Archive (TAR)" },
  { "extensions": ["tif", "tiff"], "mime": "image/tiff", "description": "Tagged Image File Format (TIFF)" },
  // { "extensions": ["ts"], "mime": "video/mp2t", "description": "MPEG transport stream" },
  { "extensions": ["ttf"], "mime": "font/ttf", "description": "TrueType Font" },
  { "extensions": ["txt"], "mime": "text/plain", "description": "Text, (generally ASCII or ISO 8859-n)" },
  { "extensions": ["vsd"], "mime": "application/vnd.visio", "description": "Microsoft Visio" },
  { "extensions": ["wav"], "mime": "audio/wav", "description": "Waveform Audio Format" },
  { "extensions": ["weba"], "mime": "audio/webm", "description": "WEBM audio" },
  { "extensions": ["webm"], "mime": "video/webm", "description": "WEBM video" },
  { "extensions": ["webp"], "mime": "image/webp", "description": "WEBP image" },
  { "extensions": ["woff"], "mime": "font/woff", "description": "Web Open Font Format (WOFF)" },
  { "extensions": ["woff2"], "mime": "font/woff2", "description": "Web Open Font Format (WOFF)" },
  { "extensions": ["xhtml"], "mime": "application/xhtml+xml", "description": "XHTML" },
  { "extensions": ["xls"], "mime": "application/vnd.ms-excel", "description": "Microsoft Excel" },
  { "extensions": ["xlsx"], "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "description": "Microsoft Excel (OpenXML)" },
  { "extensions": ["xml"], "mime": "application/xml", "description": "XML; application/xml - if not readable from casual users (RFC 3023, section 3); text/xml - if readable from casual users (RFC 3023, section 3)" },
  { "extensions": ["xul"], "mime": "application/vnd.mozilla.xul+xml", "description": "XUL" },
  { "extensions": ["zip"], "mime": "application/zip", "description": "ZIP archive" },
  { "extensions": ["3gp"], "mime": "video/3gpp", "description": "3GPP audio/video container" },
  { "extensions": ["3g2"], "mime": "video/3gpp2", "description": "3GPP2 audio/video container; audio/3gpp if it doesn't contain video; audio/3gpp2 if it doesn't contain video" },
  { "extensions": ["7z"], "mime": "application/x-7z-compressed", "description": "7-zip archive" },

  { "extensions": ["jsx"], "mime": "text/jsx", "description": "JavaScript Syntax Extension / JavaScript XML format" },
  { "extensions": ["ts"], "mime": "text/ts", "description": "TypeScript format" },
  { "extensions": ["tsx"], "mime": "text/tsx", "description": "TypeScript Syntax Extension / TypeScript XML format" },

]

export const mimeTypesDescriptions = mimeTypes.reduce((index, t) => {
  index[t.mime] = t.description;
  return index;
}, {});

export const extensionToMimeType = mimeTypes.reduce((index, t) => {
  for (const ext of t.extensions) {
    index[ext] = t.mime;
  }
  return index;
}, {});

export const mimeTypeToExtensions = mimeTypes.reduce((index, t) => {
  index[t.mime] = t.extensions;
  return index;
}, {});