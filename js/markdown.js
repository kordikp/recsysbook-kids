// Markdown to HTML converter with table, math, and diagram support

export function renderMarkdown(text) {
  if (!text || !text.trim()) return '';

  // Pre-process: protect math blocks from all formatting
  const mathStore = [];
  // Display math $$...$$ (can be multiline)
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m) => { mathStore.push(m); return `%%MATH${mathStore.length - 1}%%`; });
  // Inline math $...$ — only match if content has LaTeX chars (\, ^, _, {, })
  // This prevents matching currency like "$15 billion"
  text = text.replace(/\$([^\$\n]*?[\\^_{}][^\$\n]*?)\$/g, (m) => { mathStore.push(m); return `%%MATH${mathStore.length - 1}%%`; });
  // Code blocks ```...```
  const codeStore = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    codeStore.push({ lang, code: code.trimEnd() });
    return `%%CODE${codeStore.length - 1}%%`;
  });

  const lines = text.split('\n');
  const result = [];
  let inList = false;
  let listType = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Code block placeholder
    const codeMatch = line.match(/^%%CODE(\d+)%%$/);
    if (codeMatch) {
      if (inList) { result.push(closeList(listType)); inList = false; }
      const { lang, code } = codeStore[parseInt(codeMatch[1])];
      result.push(`<pre><code class="language-${lang || 'text'}">${escapeHtml(code)}</code></pre>`);
      continue;
    }

    // Math block placeholder (display)
    const mathMatch = line.match(/^%%MATH(\d+)%%$/);
    if (mathMatch) {
      if (inList) { result.push(closeList(listType)); inList = false; }
      const m = mathStore[parseInt(mathMatch[1])];
      if (m.startsWith('$$')) result.push('<span class="math-display">' + m + '</span>');
      else result.push('<span class="math-inline">' + m + '</span>');
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      if (inList) { result.push(closeList(listType)); inList = false; }
      result.push('<hr>');
      continue;
    }

    // Table: detect | delimited rows
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      if (inList) { result.push(closeList(listType)); inList = false; }
      const tableLines = [line];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
        i++;
        tableLines.push(lines[i]);
      }
      result.push(renderTable(tableLines));
      continue;
    }

    // Headers
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      if (inList) { result.push(closeList(listType)); inList = false; }
      result.push(`<h${hm[1].length}>${inlineFmt(hm[2])}</h${hm[1].length}>`);
      continue;
    }

    // Unordered list
    const ulm = line.match(/^[\s]*[-*]\s+(.+)$/);
    if (ulm) {
      if (!inList || listType !== 'ul') { if (inList) result.push(closeList(listType)); result.push('<ul>'); inList = true; listType = 'ul'; }
      result.push(`<li>${inlineFmt(ulm[1])}</li>`);
      continue;
    }

    // Ordered list
    const olm = line.match(/^[\s]*\d+[.)]\s+(.+)$/);
    if (olm) {
      if (!inList || listType !== 'ol') { if (inList) result.push(closeList(listType)); result.push('<ol>'); inList = true; listType = 'ol'; }
      result.push(`<li>${inlineFmt(olm[1])}</li>`);
      continue;
    }

    // Close list on empty line
    if (inList && line.trim() === '') { result.push(closeList(listType)); inList = false; continue; }

    // Standalone image (block-level, not wrapped in <p>)
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgMatch) {
      if (inList) { result.push(closeList(listType)); inList = false; }
      result.push(`<figure class="md-figure"><img src="${imgMatch[2]}" alt="${imgMatch[1]}" style="max-width:100%;border-radius:8px;display:block;margin:1em auto;"></figure>`);
      continue;
    }

    // Empty line
    if (line.trim() === '') continue;

    // Paragraph
    if (inList) { result.push(closeList(listType)); inList = false; }
    let para = line;
    while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !isBlockStart(lines[i + 1])) {
      i++;
      para += ' ' + lines[i];
    }
    result.push(`<p>${inlineFmt(para)}</p>`);
  }

  if (inList) result.push(closeList(listType));

  let html = result.join('\n');

  // Restore math — wrap in spans for targeted KaTeX rendering
  html = html.replace(/%%MATH(\d+)%%/g, (_, idx) => {
    const m = mathStore[parseInt(idx)];
    if (m.startsWith('$$')) return '<span class="math-display">' + m + '</span>';
    return '<span class="math-inline">' + m + '</span>';
  });

  return html;
}

function closeList(type) { return type === 'ul' ? '</ul>' : '</ol>'; }

function isBlockStart(line) {
  return /^#{1,6}\s/.test(line) || /^[-*]\s/.test(line) || /^\d+[.)]\s/.test(line) ||
    /^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line) || /^\|/.test(line) || /^%%/.test(line) ||
    /^!\[/.test(line); // standalone image
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Table rendering ---
function renderTable(lines) {
  // Filter separator rows (|---|---|)
  const dataRows = [];
  let headerSepIdx = -1;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
      if (headerSepIdx < 0) headerSepIdx = i;
    } else {
      dataRows.push({ cells: parseCells(trimmed), idx: i });
    }
  });

  if (dataRows.length === 0) return '';

  let html = '<div class="table-wrap"><table>';

  // If there's a header separator, first row is header
  if (headerSepIdx > 0 && dataRows.length > 1) {
    html += '<thead><tr>';
    dataRows[0].cells.forEach(c => { html += `<th>${inlineFmt(c)}</th>`; });
    html += '</tr></thead><tbody>';
    for (let i = 1; i < dataRows.length; i++) {
      html += '<tr>';
      dataRows[i].cells.forEach(c => { html += `<td>${inlineFmt(c)}</td>`; });
      html += '</tr>';
    }
    html += '</tbody>';
  } else {
    html += '<tbody>';
    dataRows.forEach(row => {
      html += '<tr>';
      row.cells.forEach(c => { html += `<td>${inlineFmt(c)}</td>`; });
      html += '</tr>';
    });
    html += '</tbody>';
  }

  html += '</table></div>';
  return html;
}

function parseCells(line) {
  // Split by | and trim, ignoring first and last empty cells
  return line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
}

// --- Inline formatting ---
function inlineFmt(text) {
  // Protect math from inline processing
  const mathBlocks = [];
  text = text.replace(/%%MATH(\d+)%%/g, (m) => { mathBlocks.push(m); return `%%IM${mathBlocks.length - 1}%%IM`; });
  // Also protect inline $...$ that survived
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m) => { mathBlocks.push(m); return `%%IM${mathBlocks.length - 1}%%IM`; });
  text = text.replace(/\$([^\$\n]+?)\$/g, (m) => { mathBlocks.push(m); return `%%IM${mathBlocks.length - 1}%%IM`; });

  // Inline code (protect from further processing)
  const codeBlocks = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => { codeBlocks.push(`<code>${escapeHtml(code)}</code>`); return `%%IC${codeBlocks.length - 1}%%IC`; });

  // Images
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;">');
  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Bold+italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic (careful with LaTeX subscripts)
  text = text.replace(/(?<![\\*\w])\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');

  // Restore code
  text = text.replace(/%%IC(\d+)%%IC/g, (_, idx) => codeBlocks[parseInt(idx)]);
  // Restore math
  text = text.replace(/%%IM(\d+)%%IM/g, (_, idx) => mathBlocks[parseInt(idx)]);

  return text;
}

// --- YAML frontmatter parser ---
export function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text.trim() };
  return { meta: parseYaml(match[1]), body: match[2].trim() };
}

function parseYaml(yaml) {
  const result = {};
  const lines = yaml.split('\n');
  let ck = null, ca = null;
  for (const line of lines) {
    const am = line.match(/^\s+-\s+(.*)/);
    if (am && ck) {
      if (!ca) ca = [];
      const val = am[1].trim();
      if (val.includes(':')) {
        const obj = {};
        for (const part of val.split(/,\s*/)) { const [k, ...v] = part.split(':'); if (k && v.length) obj[k.trim()] = cleanVal(v.join(':').trim()); }
        ca.push(obj);
      } else ca.push(cleanVal(val));
      result[ck] = ca;
      continue;
    }
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)/);
    if (kv) {
      if (ca && ck) result[ck] = ca;
      ck = kv[1].trim();
      const v = kv[2].trim();
      if (v === '' || v === '[]') { ca = []; result[ck] = ca; }
      else { ca = null; result[ck] = cleanVal(v); }
      continue;
    }
    const nm = line.match(/^\s{4,}(\w[\w-]*)\s*:\s*(.*)/);
    if (nm && ca && ca.length > 0) {
      const last = ca[ca.length - 1];
      if (typeof last === 'object') last[nm[1].trim()] = cleanVal(nm[2].trim());
    }
  }
  return result;
}

function cleanVal(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  if (/^\d+\.\d+$/.test(v)) return parseFloat(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  return v;
}
