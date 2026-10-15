/**
 * A Gmail web link that finds this exact message by its Message-ID, in the connected account.
 * "" when there is nothing safe to search for: no Message-ID, or one this app made up for a message
 * that had none (Gmail has never seen it).
 */
export function gmailLink(messageId: string, account: string): string {
  const id = messageId.trim().replace(/^<|>$/g, "");
  if (!id || /\.synthetic@localhost$/i.test(id) || /[\s<>]/.test(id) || id.length > 500) return "";
  const who = account.trim() ? `?authuser=${encodeURIComponent(account.trim())}` : "";
  return `https://mail.google.com/mail/${who}#search/${encodeURIComponent(`rfc822msgid:${id}`)}`;
}
