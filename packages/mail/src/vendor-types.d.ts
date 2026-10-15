// Minimal types for the two mail libraries that publish none. Only what CareerOS uses.

declare module "mailparser" {
  export interface AddressEntry { name: string; address?: string; group?: AddressEntry[] }
  export interface AddressObject { value: AddressEntry[]; text: string; html: string }
  export interface Attachment {
    filename?: string; contentType: string; contentDisposition?: string; size: number; content: Buffer;
    contentId?: string; cid?: string; related?: boolean; checksum?: string;
  }
  export interface ParsedMail {
    headers: Map<string, unknown>;
    headerLines: { key: string; line: string }[];
    subject?: string; from?: AddressObject; to?: AddressObject | AddressObject[]; cc?: AddressObject | AddressObject[];
    replyTo?: AddressObject; date?: Date; messageId?: string; inReplyTo?: string; references?: string | string[];
    html: string | false; text?: string; textAsHtml?: string; attachments: Attachment[];
  }
  export interface SimpleParserOptions {
    keepCidLinks?: boolean; skipHtmlToText?: boolean; skipImageLinks?: boolean; skipTextToHtml?: boolean;
    skipTextLinks?: boolean; maxHtmlLengthToParse?: number;
  }
  export function simpleParser(source: Buffer | string, options?: SimpleParserOptions): Promise<ParsedMail>;
}

declare module "sanitize-html" {
  namespace sanitizeHtml {
    interface Attributes { [name: string]: string }
    interface Frame { tag: string; attribs: Attributes; text: string; tagPosition: number }
    type Transformer = (tagName: string, attribs: Attributes) => { tagName: string; attribs: Attributes; text?: string };
    interface IOptions {
      allowedTags?: string[] | false;
      allowedAttributes?: Record<string, string[]> | false;
      allowedSchemes?: string[];
      allowedSchemesByTag?: Record<string, string[]>;
      allowedSchemesAppliedToAttributes?: string[];
      allowProtocolRelative?: boolean;
      allowedStyles?: Record<string, Record<string, RegExp[]>>;
      parseStyleAttributes?: boolean;
      transformTags?: Record<string, string | Transformer>;
      exclusiveFilter?: (frame: Frame) => boolean;
      disallowedTagsMode?: "discard" | "escape" | "recursiveEscape";
      nonTextTags?: string[];
      enforceHtmlBoundary?: boolean;
    }
  }
  function sanitizeHtml(dirty: string, options?: sanitizeHtml.IOptions): string;
  export = sanitizeHtml;
}
