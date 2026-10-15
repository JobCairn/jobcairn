/**
 * Files and folders the operating system or an office app makes on its own (Finder's .DS_Store and ._ files,
 * Spotlight and Trash folders, Windows' Thumbs.db and desktop.ini, Office's ~$ lock files). Never counted as
 * someone's change or as "other files" in a folder. Matched on the base name, any case.
 */
const OS_JUNK = /^(?:\.DS_Store|\._.*|thumbs\.db|ehthumbs\.db|desktop\.ini|\.Spotlight-V100|\.Trashes|\.fseventsd|\.TemporaryItems|\.DocumentRevisions-V100|~\$.*)$/i;
export const isOsJunk = (name: string): boolean => OS_JUNK.test(name);
