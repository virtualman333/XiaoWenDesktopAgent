/**
 * 极简 Markdown 渲染（安全优先：先转义 HTML，再套用有限语法）
 */
export function renderMarkdown(src) {
  if (!src) return '';

  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;')
     .replace(/</g, '&lt;')
     .replace(/>/g, '&gt;')
     .replace(/"/g, '&quot;')
     .replace(/'/g, '&#39;');

  // 1. 先抽出代码块，避免其内容被当作 markdown 处理
  const codeBlocks = [];
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
    return `\u0000CODE${idx}\u0000`;
  });

  // 2. 行内代码
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\u0000ICODE${idx}\u0000`;
  });

  // 3. 转义 HTML
  text = escapeHtml(text);

  // 4. 表格
  text = text.replace(
    /(^\|.+\|\s*\n\|[\s:|-]+\|\s*\n(?:\|.*\|\s*\n?)*)/gm,
    (block) => {
      const lines = block.trim().split('\n');
      if (lines.length < 2) return block;
      const parseRow = (line) =>
        line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = parseRow(lines[0]);
      const body = lines.slice(2).map(parseRow);
      let html = '<table><thead><tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
      body.forEach((row) => {
        html += '<tr>' + row.map((c) => `<td>${c}</td>`).join('') + '</tr>';
      });
      return html + '</tbody></table>\n';
    }
  );

  // 5. 标题
  text = text.replace(/^######\s+(.*)$/gm, '<h6>$1</h6>');
  text = text.replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>');
  text = text.replace(/^####\s+(.*)$/gm, '<h4>$1</h4>');
  text = text.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
  text = text.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
  text = text.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');

  // 6. 引用
  text = text.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  text = text.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // 7. 列表
  text = text.replace(/^[\-\*]\s+(.*)$/gm, '<li>$1</li>');
  text = text.replace(/^\d+\.\s+(.*)$/gm, '<li>$1</li>');
  text = text.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, (m) => `<ul>${m}</ul>`);
  text = text.replace(/<\/ul>\s*<ul>/g, '');

  // 8. 水平线
  text = text.replace(/^---+$/gm, '<hr/>');

  // 9. 粗体 / 斜体 / 删除线 / 链接
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // 10. 段落：把连续的非块级行包进 <p>
  const blockTags = /^\s*<(h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|pre|blockquote|hr|div)/;
  const lines = text.split('\n');
  const out = [];
  let buffer = [];

  const flush = () => {
    if (buffer.length) {
      const joined = buffer.join('<br/>');
      if (joined.trim()) out.push(`<p>${joined}</p>`);
      buffer = [];
    }
  };

  lines.forEach((line) => {
    const t = line.trim();
    if (!t) {
      flush();
      return;
    }
    if (blockTags.test(t) || /\u0000CODE\d+\u0000/.test(t)) {
      flush();
      out.push(t);
    } else {
      buffer.push(t);
    }
  });
  flush();

  let html = out.join('\n');

  // 11. 还原行内代码
  html = html.replace(/\u0000ICODE(\d+)\u0000/g, (_m, i) => `<code>${escapeHtml(inlineCodes[i])}</code>`);

  // 12. 还原代码块
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => {
    const { lang, code } = codeBlocks[i];
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    return `<pre><code${cls}>${escapeHtml(code)}</code></pre>`;
  });

  return html;
}

/**
 * 去掉 markdown 标记，得到适合语音朗读的纯文本
 */
export function toPlainText(src) {
  if (!src) return '';
  return src
    .replace(/```[\s\S]*?```/g, '（代码块）')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\-\*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^\|.*\|$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^---+$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
