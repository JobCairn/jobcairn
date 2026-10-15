/**
 * Every icon the app shows, by what it means. This is the ONLY file that imports lucide-react
 * (tests/brand-lint enforces it), so swapping any icon is a one-line change here.
 * Brand glyphs (glyphs.tsx) cover the app's own ideas; lucide covers generic ones.
 */
import type { ComponentType, SVGProps } from "react";
import {
  Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookOpen, Briefcase, Building2, Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp,
  Circle, CircleCheck, CircleHelp, Copy, ExternalLink, Eye, EyeOff, FileDown, FilePlus, FileText, Folder, FolderOpen, FolderPlus, History, House,
  ImageOff, Info, KeyRound, Maximize2, Minimize2, ListChecks, Lock, LockOpen, Mail, MailPlus, MessageSquare, Palette, PanelLeftClose, PanelLeftOpen, Paperclip, Pause, Play, Plus, Reply, RotateCcw, Save,
  Search, Send, Settings, SkipBack, SkipForward, SlidersHorizontal, Square, Target, Trash2, Undo2, UserRound, Video, Volume2, Wallet, X,
  // Recruiters (ui/recruiters)
  Phone, Star, UsersRound,
  // Table status marks (ui/jobs-cells)
  BadgeCheck, Bookmark, CircleDashed, CircleSlash, CircleX, PenLine, Shield, ShieldCheck, ShieldQuestion, ShieldX,
  // List editor and quick filters (ui/search-filters)
  GripVertical, ListFilter, MapPin,
  // Resume Studio and the Resumes file grid (ui/resume-studio)
  Ellipsis, LayoutGrid, Link2, List, Rows3,
  // Guide reader: callouts and section marks (ui/learn-visual)
  BookA, CodeXml, Layers, Lightbulb, Scale, TriangleAlert, Workflow,
} from "lucide-react";
import { GLYPHS as GLYPH_NODES, makeGlyph, type GlyphName } from "./glyphs";

export type IconGlyph = ComponentType<SVGProps<SVGSVGElement> & { strokeWidth?: number | string }>;

/** The AI-action glyph in use. Candidates: stepOut (default), stepIn, drawUp. */
export const AI_GLYPH: GlyphName = "stepOut";
export const AI_CANDIDATES: GlyphName[] = ["stepOut", "stepIn", "drawUp"];

export const Icons = {
  // Brand glyphs
  ai: makeGlyph(AI_GLYPH),
  apply: makeGlyph("apply"),
  dropBox: makeGlyph("dropBox"),
  learn: makeGlyph("learn"),
  sponsors: makeGlyph("sponsor"),
  // Navigation
  home: House,
  jobs: Briefcase,
  searches: Search,
  approvals: CircleCheck,
  privacy: Lock,
  settings: Settings,
  mail: Mail,
  /** "Choose how" (a request's options), so it never reads as the page's settings gear. */
  tune: SlidersHorizontal,
  // Actions and things
  locked: Lock,
  unlocked: LockOpen,
  openExternal: ExternalLink,
  showInFolder: FolderOpen,
  folder: Folder,
  newFolder: FolderPlus,
  newFile: FilePlus,
  file: FileText,
  attach: Paperclip,
  send: Send,
  reply: Reply,
  /** Write a new email. */
  compose: MailPlus,
  save: Save,
  /** Remote images held back in an email. */
  imagesBlocked: ImageOff,
  remove: Trash2,
  copy: Copy,
  redo: RotateCcw,
  exportFile: FileDown,
  history: History,
  /** Move to the Trash (recoverable). */
  trash: Trash2,
  /** Put a file back where it came from. */
  putBack: Undo2,
  guide: BookOpen,
  video: Video,
  interview: MessageSquare,
  add: Plus,
  /** A step that isn't available yet (Getting started's "coming soon"). */
  pending: Circle,
  check: Check,
  close: X,
  info: Info,
  /** "Show me around": the guided tour help button. */
  help: CircleHelp,
  back: ArrowLeft,
  next: ArrowRight,
  expand: ChevronDown,
  collapse: ChevronUp,
  /** A folded-away group in the sidebar (points right; open groups use `expand`). */
  folded: ChevronRight,
  /** The sidebar toggle: fold it to icons, or open it back up. */
  sidebarCollapse: PanelLeftClose,
  sidebarExpand: PanelLeftOpen,
  /** Step to the previous / next item sideways (the file viewer, where Up and Down scroll the document). */
  stepPrev: ChevronLeft,
  stepNext: ChevronRight,
  /** Widen a side panel to the full window, and back. */
  widen: Maximize2,
  narrow: Minimize2,
  sortAsc: ArrowUp,
  sortDesc: ArrowDown,
  sortNone: ChevronsUpDown,
  // List editor and quick filters (ui/search-filters): reorder a row, drag it, filter a list, a place.
  moveUp: ArrowUp,
  moveDown: ArrowDown,
  dragHandle: GripVertical,
  filter: ListFilter,
  place: MapPin,
  // Resume Studio and the Resumes file grid (ui/resume-studio): a "more actions" menu, grid and list views, a link.
  more: Ellipsis,
  gridView: LayoutGrid,
  listView: List,
  link: Link2,
  section: Rows3,
  // Read aloud (Lane E)
  listen: Volume2,
  play: Play,
  pause: Pause,
  previous: SkipBack,
  skipNext: SkipForward,
  stop: Square,
  // Section headers (Settings and other cards)
  activity: Activity,
  key: KeyRound,
  palette: Palette,
  user: UserRound,
  target: Target,
  salary: Wallet,
  company: Building2,
  recruiters: UsersRound,
  favourite: Star,
  phone: Phone,
  calendar: Calendar,
  checklist: ListChecks,
  show: Eye,
  hide: EyeOff,
  // Table status marks (ui/jobs-cells): a job's stage and an ad's work-rights wording, always shown with a word.
  found: CircleDashed,
  saved: Bookmark,
  applying: PenLine,
  offer: BadgeCheck,
  rejected: CircleX,
  skipped: CircleSlash,
  sponsorYes: ShieldCheck,
  sponsorNo: ShieldX,
  visaOk: Shield,
  silent: ShieldQuestion,
  // Guide reader (ui/learn-visual): callouts and section marks
  tip: Lightbulb,
  watchOut: TriangleAlert,
  keyTerms: BookA,
  example: CodeXml,
  concepts: Layers,
  compare: Scale,
  flow: Workflow,
} satisfies Record<string, IconGlyph>;
export type IconKey = keyof typeof Icons;
/** The AI-action glyph under a stable name (same component as Icons.ai). */
export const AiMark: IconGlyph = Icons.ai;

/** Every brand glyph as a component, for the guide and candidate sheets. */
export const Glyphs = Object.fromEntries((Object.keys(GLYPH_NODES) as GlyphName[]).map((n) => [n, makeGlyph(n)])) as unknown as Record<GlyphName, IconGlyph>;
export { GLYPHS, glyphSvg, type GlyphName } from "./glyphs";
