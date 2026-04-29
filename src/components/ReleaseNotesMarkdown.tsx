import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";

interface ReleaseNotesMarkdownProps {
  markdown: string;
}

/** 更新说明 / Release body 的 Markdown 渲染（检查更新弹窗与设置页共用） */
export function ReleaseNotesMarkdown({ markdown }: ReleaseNotesMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw]}
      className="prose prose-sm max-w-none"
      components={{
        h1: ({ node, children, ...props }) => (
          <h1 className="text-xl font-bold mt-4 mb-2 text-gray-800" {...props}>{children}</h1>
        ),
        h2: ({ node, children, ...props }) => (
          <h2 className="text-lg font-bold mt-3 mb-2 text-gray-800" {...props}>{children}</h2>
        ),
        h3: ({ node, children, ...props }) => (
          <h3 className="text-base font-bold mt-2 mb-1 text-gray-800" {...props}>{children}</h3>
        ),
        ul: ({ node, children, ...props }) => (
          <ul className="list-disc pl-5 mt-1 mb-2 space-y-1" {...props}>{children}</ul>
        ),
        ol: ({ node, children, ...props }) => (
          <ol className="list-decimal pl-5 mt-1 mb-2 space-y-1" {...props}>{children}</ol>
        ),
        li: ({ node, children, ...props }) => (
          <li className="mb-0.5" {...props}>{children}</li>
        ),
        code: ({ children, ...props }) => (
          <code className="bg-gray-200 px-1 py-0.5 rounded text-sm font-mono" {...props}>{children}</code>
        ),
        pre: ({ children, ...props }) => (
          <pre className="bg-gray-200 p-3 rounded overflow-x-auto text-sm font-mono mb-2" {...props}>{children}</pre>
        ),
        a: ({ node, children, ...props }) => (
          <a className="text-blue-600 hover:underline" {...props}>{children}</a>
        ),
        strong: ({ node, children, ...props }) => (
          <strong className="font-semibold" {...props}>{children}</strong>
        ),
        br: ({ node, ...props }) => <br {...props} />,
        p: ({ node, children, ...props }) => (
          <p className="mb-2" {...props}>{children}</p>
        ),
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
