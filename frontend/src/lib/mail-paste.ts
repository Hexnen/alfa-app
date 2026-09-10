/**
 * Przygotowanie HTML-a maila pod wklejenie do Outlooka/Worda.
 *
 * Wydzielone z `components/OrderMailPreviewDialog.tsx` — z tego samego korzysta
 * okno maili Grup interwencyjnych. Zachowanie bez zmian: przycinamy dokument do
 * `<body>` i zdejmujemy ukryty preheader.
 */

/**
 * Outlook wkleja tylko fragment — `<head>` (a więc i `<title>`) ignoruje, więc
 * podanie mu całego dokumentu nic nie daje, a bywa, że psuje. Style szablonu są
 * inline'owe, żaden nie siedzi w `<head>`, więc przy zejściu do `<body>` nic nie
 * ginie. Dodatkowo zdejmujemy ukryty preheader z początku body: w mailu jest
 * niewidoczny (`display:none`), ale Word potrafi go pokazać jako pierwszą linijkę.
 */
export function toPasteHtml(fullHtml: string): string {
  try {
    const doc = new DOMParser().parseFromString(fullHtml, "text/html");
    const body = doc.body;
    if (!body) return fullHtml;
    // Zdejmujemy z początku body komentarze i puste teksty (szablon ma tam
    // komentarz opisujący preheader) oraz sam ukryty preheader.
    for (let node = body.firstChild; node; node = body.firstChild) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) {
        node.remove();
        continue;
      }
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
      const style = (el?.getAttribute("style") ?? "").replace(/\s+/g, "");
      if (!el || !style.includes("display:none")) break;
      el.remove();
    }
    const inner = body.innerHTML.trim();
    return inner || fullHtml;
  } catch {
    // DOMParser nie powinien rzucać, ale wolimy skopiować cokolwiek niż nic.
    return fullHtml;
  }
}
