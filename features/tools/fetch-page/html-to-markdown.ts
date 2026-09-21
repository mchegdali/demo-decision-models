import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.use(gfm);

export function htmlToMarkdown(html: string, baseUrl: string): { title: string; markdown: string } {
  const dom = new JSDOM(html, { url: baseUrl });
  const document = dom.window.document;

  const article = new Readability(document).parse();
  if (article?.content) {
    return { title: article.title ?? document.title, markdown: turndown.turndown(article.content) };
  }

  const fallbackNode =
    document.querySelector("main") ?? document.querySelector("article") ?? document.body;
  return {
    title: document.title,
    markdown: turndown.turndown(fallbackNode?.innerHTML ?? ""),
  };
}
