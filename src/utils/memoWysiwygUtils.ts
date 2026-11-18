/** Markdown（含 images/ 相对路径）↔ 所见即所得编辑 HTML */

/** 未成功落盘的图片在 Markdown 中的可见占位 */
export const UNSAVED_IMAGE_PLACEHOLDER = "[未保存的图片]";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 从 HTML 字符串提取 img 的 src（供粘贴判断与测试） */
export function extractImageSrcsFromHtml(html: string): string[] {
  if (!html || !/<img\b/i.test(html)) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = (img.getAttribute("src") || "").trim();
    if (src) out.push(src);
  }
  return out;
}

/** 是否为可尝试落盘的图片地址 */
export function isPersistableImageSrc(src: string): boolean {
  const s = src.trim();
  return (
    s.startsWith("data:image/") ||
    s.startsWith("blob:") ||
    /^https?:\/\//i.test(s)
  );
}

type Chunk =
  | { type: "text"; value: string }
  | { type: "img"; alt: string; src: string };

function splitMarkdownChunks(md: string): Chunk[] {
  const chunks: Chunk[] = [];
  const re = /!\[([^\]]*)\]\((images\/[^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    if (m.index > last) {
      chunks.push({ type: "text", value: md.slice(last, m.index) });
    }
    chunks.push({ type: "img", alt: m[1] || "图片", src: m[2] });
    last = m.index + m[0].length;
  }
  if (last < md.length) {
    chunks.push({ type: "text", value: md.slice(last) });
  }
  return chunks;
}

/** 将备忘录 Markdown 转为 contentEditable 初始 HTML（图片仅带 data-memo-src） */
export function markdownToEditorHtml(md: string): string {
  const raw = md ?? "";
  if (!raw.trim()) {
    return "<div><br></div>";
  }

  const chunks = splitMarkdownChunks(raw);
  let html = "";

  const appendTextAsDivs = (text: string) => {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 连续换行产生空行
      if (line.length === 0) {
        html += "<div><br></div>";
      } else {
        html += `<div>${escapeHtml(line)}</div>`;
      }
    }
  };

  for (const chunk of chunks) {
    if (chunk.type === "text") {
      appendTextAsDivs(chunk.value);
    } else {
      html += `<div><img data-memo-src="${escapeHtml(chunk.src)}" alt="${escapeHtml(chunk.alt)}" class="memo-wysiwyg-img" /></div>`;
    }
  }

  return html || "<div><br></div>";
}

function isBlockElement(el: HTMLElement): boolean {
  const tag = el.tagName;
  return (
    tag === "DIV" ||
    tag === "P" ||
    tag === "LI" ||
    tag === "H1" ||
    tag === "H2" ||
    tag === "H3" ||
    tag === "BLOCKQUOTE"
  );
}

/** 从编辑器根节点序列化为 Markdown */
export function editorRootToMarkdown(root: HTMLElement): string {
  const parts: string[] = [];

  const flushTextNewline = () => {
    if (parts.length === 0) return;
    const last = parts[parts.length - 1];
    if (!last.endsWith("\n")) parts.push("\n");
  };

  const walk = (node: Node, inBlock: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName;

    if (tag === "IMG") {
      const src = el.getAttribute("data-memo-src");
      if (src && src.startsWith("images/") && !src.includes("..")) {
        const alt = el.getAttribute("alt") || "图片";
        parts.push(`![${alt}](${src})`);
      } else {
        // 避免外链/未落盘图片静默丢失
        parts.push(UNSAVED_IMAGE_PLACEHOLDER);
      }
      return;
    }

    if (tag === "BR") {
      parts.push("\n");
      return;
    }

    if (isBlockElement(el)) {
      if (parts.length > 0) flushTextNewline();
      const children = Array.from(el.childNodes);
      if (
        children.length === 0 ||
        (children.length === 1 &&
          children[0].nodeType === Node.ELEMENT_NODE &&
          (children[0] as HTMLElement).tagName === "BR")
      ) {
        // 空行：仅换行即可（flush 已处理）
      } else {
        for (const child of children) walk(child, true);
      }
      flushTextNewline();
      return;
    }

    for (const child of Array.from(el.childNodes)) {
      walk(child, inBlock);
    }
  };

  for (const child of Array.from(root.childNodes)) {
    walk(child, false);
  }

  return parts.join("").replace(/\n+$/g, "");
}

/** 在选区插入 HTML（失败则追加到末尾） */
export function insertHtmlAtSelection(html: string, root: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
    root.insertAdjacentHTML("beforeend", html);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const template = document.createElement("template");
  template.innerHTML = html;
  const frag = template.content;
  const last = frag.lastChild;
  range.insertNode(frag);
  if (last) {
    range.setStartAfter(last);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
