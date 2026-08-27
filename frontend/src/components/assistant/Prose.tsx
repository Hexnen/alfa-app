import { StreamMarkdown } from "./StreamMarkdown";
import { cn } from "@/lib/utils";

/**
 * Markdown w dymkach asystenta: `asst-prose` (reguły w assistant.css) +
 * `whitespace-pre-wrap` — StreamMarkdown odtwarza odstęp między blokami
 * znakiem "\n", który wymaga pre-wrap na kontenerze.
 */
export function Prose({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("asst-prose whitespace-pre-wrap break-words", streaming && "asst-streaming", className)}>
      <StreamMarkdown text={text} streaming={streaming} />
    </div>
  );
}
