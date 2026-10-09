import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { dracula } from "react-syntax-highlighter/dist/cjs/styles/prism";

// Kept in its own module so the highlighter (Prism with every language) is
// only downloaded when a note actually contains a fenced code block.
export default function CodeBlock({
  language,
  children,
}: {
  language: string;
  children: string;
}) {
  return (
    <SyntaxHighlighter PreTag="div" language={language} style={dracula}>
      {children}
    </SyntaxHighlighter>
  );
}
