#!/usr/bin/env node
/**
 * Builds the video asset packs (packages/video/packs/*.json) from open-licence sources, once, at dev time.
 * Nothing here runs when a video is made: the app only reads the JSON this writes.
 *
 *   node packages/video/scripts/build-packs.mjs <path to an unpacked simple-icons npm package>
 *
 * - icons.json: a curated lucide subset (ISC), from the lucide-react package already in node_modules.
 * - logos.json: a curated Simple Icons subset. Only icons with no licence of their own (CC0, the package
 *   licence) or a permissive one (MIT, Apache-2.0) are kept; share-alike and non-commercial ones are left out.
 * - architecture.json: generic system node kinds drawn with lucide icons and our own styling. No vendor
 *   architecture icon sets (AWS, GCP, Azure): their terms restrict use.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, "../../..");
const out = path.join(repo, "packages/video/packs");
const require = createRequire(import.meta.url);
const lucideDir = path.join(path.dirname(require.resolve("lucide-react/package.json")), "dist/esm/icons");
const lucideVersion = JSON.parse(fs.readFileSync(path.join(lucideDir, "../../../package.json"), "utf8")).version;

// name -> tags (words a requirement or a node label might use)
const ICONS = {
  server: "server backend host machine", layers: "stack layers platform", boxes: "modules components services", workflow: "workflow process orchestration",
  bot: "agent agents bot chatbot assistant automation", sparkles: "ai genai generative llm", brain: "ml machine learning model neural deep learning intelligence",
  cpu: "cpu compute gpu hardware performance", network: "network distributed networking topology", database: "database sql data storage postgres",
  cloud: "cloud aws gcp azure saas", shield: "security secure safety", lock: "privacy encryption auth access", users: "team collaboration people stakeholders",
  user: "person candidate customer", "message-square": "communication chat messaging", mic: "voice speech audio", rocket: "ship launch deploy startup",
  "chart-line": "metrics growth analytics trend", "chart-column": "analytics reporting bar chart", activity: "monitoring observability health", "git-branch": "git version control branching",
  "git-merge": "merge code review pull request", terminal: "cli shell scripting bash linux", box: "package container product", "book-open": "documentation learning reading",
  "graduation-cap": "degree education phd university", briefcase: "experience job work years", "building-2": "company office enterprise", "map-pin": "location city onsite",
  globe: "global remote internet web", clock: "time hours", calendar: "schedule date", check: "yes done match", x: "no gap missing", "circle-check": "met match pass",
  "circle-x": "gap fail missing", "circle-dashed": "partial in progress", target: "goal focus outcome", flag: "milestone priority", zap: "fast speed latency real-time cache",
  gauge: "performance throughput benchmark", "file-text": "document writing spec", search: "search retrieval rag discovery", filter: "filtering ranking", link: "integration api link",
  plug: "api plugin integration connector", key: "keys secrets credentials", eye: "vision review visibility", handshake: "partnership stakeholder client",
  "trending-up": "growth scale improvement", "dollar-sign": "salary cost pricing budget", scale: "trade-off balance compliance", puzzle: "problem solving integration",
  lightbulb: "ideas innovation product sense", wrench: "tooling maintenance debugging", settings: "configuration infrastructure ops", "hard-drive": "storage disk checkpoint",
  monitor: "desktop frontend ui", smartphone: "mobile app ios android", laptop: "developer workstation", router: "router nat gateway", wifi: "wireless connectivity",
  "radio-tower": "broadcast signal", "share-2": "p2p peer sharing decentralised", split: "sharding split partition load balancing", merge: "aggregation merge",
  repeat: "iteration retry loop", "refresh-cw": "sync refresh update", timer: "latency timing deadline", hourglass: "waiting duration", "list-checks": "requirements checklist",
  "clipboard-check": "testing qa verification", "flask-conical": "research experiments", microscope: "research analysis", "cloud-upload": "deploy upload",
  send: "send deliver", mail: "email", phone: "call phone interview", video: "video", image: "image vision", palette: "design ui", "layout-dashboard": "dashboard",
  table: "table data", award: "award certification", star: "favourite quality", trophy: "achievement win", compass: "direction strategy", route: "routing path",
  milestone: "roadmap milestone", container: "docker containers", cog: "worker job processing", "scroll-text": "logs history", "square-function": "function serverless lambda",
  "app-window": "web app browser", "user-check": "hiring approved", "users-round": "community", "shield-check": "auth verified compliance", languages: "languages i18n nlp",
  "file-code": "code source", braces: "json api code", binary: "binary low level", "memory-stick": "memory ram", archive: "archive backup", package: "package library dependency",
  "chart-pie": "share breakdown", sigma: "math statistics", atom: "science physics", "database-zap": "vector database embeddings", "calendar-clock": "scheduler cron",
  "list-ordered": "queue ordered", "arrow-right-left": "exchange sync", "server-cog": "service backend api", "cloud-cog": "cloud platform managed", "git-fork": "open source fork",
  waypoints: "graph nodes mesh", "satellite-dish": "streaming signal", cable: "connection wiring", earth: "world global", "heart-handshake": "culture care",
  "message-circle": "conversation", quote: "quote", code: "code programming software", "code-xml": "html web code", "chevrons-right": "next", diamond: "decision",
  "circle-help": "question unknown", "log-in": "login sign in", "log-out": "logout", "mouse-pointer-click": "click user action", "panels-top-left": "screen page",
  "square-stack": "screens stack", bell: "notification alert", inbox: "inbox queue", "hand-coins": "pay billing", presentation: "presentation demo", "pen-line": "write edit",
  "notebook-pen": "notes", "badge-check": "verified certified", "scan-search": "inspect evaluate",
};

// Architecture node kinds: kind -> [label, lucide icon, tags]
const ARCH = {
  service: ["Service", "server-cog", "service api backend microservice"], queue: ["Queue", "list-ordered", "queue kafka sqs pubsub broker stream"],
  database: ["Database", "database", "database sql postgres mysql store"], cache: ["Cache", "zap", "cache redis memcached"],
  "load-balancer": ["Load balancer", "split", "load balancer lb ingress proxy nginx"], gpu: ["GPU node", "cpu", "gpu node compute training inference"],
  storage: ["Storage", "hard-drive", "storage bucket s3 blob object checkpoint"], client: ["Client", "monitor", "client browser frontend user"],
  peer: ["Peer", "share-2", "peer node p2p"], user: ["User", "user", "user person"], api: ["API", "plug", "api gateway endpoint rest grpc"],
  model: ["Model", "brain", "model llm ml inference"], "vector-db": ["Vector DB", "database-zap", "vector embeddings index"], worker: ["Worker", "cog", "worker job consumer"],
  scheduler: ["Scheduler", "calendar-clock", "scheduler cron orchestrator"], monitoring: ["Monitoring", "activity", "monitoring metrics prometheus grafana"],
  logs: ["Logs", "scroll-text", "logs logging"], auth: ["Auth", "shield-check", "auth identity login"], cdn: ["CDN", "globe", "cdn edge"],
  router: ["Router", "router", "router nat gateway relay"], internet: ["Internet", "earth", "internet wan"], container: ["Container", "container", "container docker pod"],
  cluster: ["Cluster", "boxes", "cluster kubernetes nodes"], function: ["Function", "square-function", "function lambda serverless"], mobile: ["Mobile", "smartphone", "mobile app"],
  agent: ["Agent", "bot", "agent llm assistant"],
};

const attrs = (o) => Object.entries(o).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])}"`).join(" ");
function lucide(name) {
  const src = fs.readFileSync(path.join(lucideDir, `${name}.mjs`), "utf8");
  const alias = /export \{ default \} from '\.\/([a-z0-9-]+)\.mjs'/.exec(src);
  if (alias) return lucide(alias[1]);
  const m = /const __iconData = (\{[\s\S]*?\n\});/.exec(src);
  if (!m) throw new Error(`can't read lucide ${name}`);
  const data = Function(`return (${m[1]})`)();
  return data.node.map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join("");
}

const icons = {};
for (const [name, tags] of Object.entries(ICONS)) icons[name] = { tags: tags.split(" "), svg: lucide(name) };
for (const [, icon] of Object.values(ARCH)) if (!icons[icon]) throw new Error(`architecture icon ${icon} is not in the icon pack`);

// Simple Icons: title -> extra aliases
const LOGOS = {
  Python: "py asyncio async python", Prometheus: "", Grafana: "", Kubernetes: "k8s", PyTorch: "torch", TensorFlow: "tf", Docker: "containers", PostgreSQL: "postgres",
  Redis: "", "Apache Kafka": "kafka", Go: "golang", TypeScript: "ts", JavaScript: "js", React: "reactjs", "Node.js": "node nodejs", FastAPI: "", LangChain: "", Anthropic: "claude",
  "Hugging Face": "huggingface hf transformers", Terraform: "iac", "Google Cloud": "gcp", Linux: "", GitHub: "", GitLab: "", Ray: "", NVIDIA: "cuda", MongoDB: "mongo",
  Elasticsearch: "elastic", "Apache Spark": "spark pyspark", Snowflake: "", Databricks: "", "Apache Airflow": "airflow", GraphQL: "", "Next.js": "nextjs", "C++": "cpp",
  Kotlin: "", Swift: "", Scala: "", Django: "", Flask: "", "GitHub Actions": "actions ci", Ansible: "", Nginx: "", RabbitMQ: "", Vercel: "", Cloudflare: "", Supabase: "",
  Firebase: "", MySQL: "", SQLite: "", Jupyter: "notebooks", NumPy: "", pandas: "", "scikit-learn": "sklearn", Keras: "", "Weights & Biases": "wandb", MLflow: "", Datadog: "",
  Sentry: "", Figma: "", Jira: "", Helm: "", Istio: "", WebRTC: "", Celery: "", Pydantic: "", Vite: "", "Tailwind CSS": "tailwind", Svelte: "", Kibana: "", Jaeger: "",
  ONNX: "", Ollama: "", Dask: "", "Apache Flink": "flink", Postman: "", Ubuntu: "", Apple: "macos ios",
};
const siDir = process.argv[2];
if (!siDir) throw new Error("usage: build-packs.mjs <unpacked simple-icons package>");
const siPkg = JSON.parse(fs.readFileSync(path.join(siDir, "package.json"), "utf8"));
const siData = JSON.parse(fs.readFileSync(path.join(siDir, "data/simple-icons.json"), "utf8"));
const siList = Array.isArray(siData) ? siData : siData.icons;
const OPEN = new Set(["MIT", "Apache-2.0"]);
const logos = {};
const skipped = [];
for (const [title, extra] of Object.entries(LOGOS)) {
  const it = siList.find((x) => x.title === title);
  if (!it) { skipped.push(`${title}: not in Simple Icons ${siPkg.version}`); continue; }
  const lic = it.license?.type ?? "CC0-1.0";
  if (it.license && !OPEN.has(lic)) { skipped.push(`${title}: ${lic}`); continue; }
  const slug = it.slug ?? title.toLowerCase().replace(/\+/g, "plus").replace(/\./g, "dot").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  const svg = fs.readFileSync(path.join(siDir, "icons", `${slug}.svg`), "utf8");
  const d = /<path d="([^"]+)"/.exec(svg)?.[1];
  if (!d) { skipped.push(`${title}: no single path`); continue; }
  const names = [title.toLowerCase(), slug, ...extra.split(" ").filter(Boolean)];
  logos[slug] = { title, hex: it.hex, path: d, license: lic, source: it.source, names: [...new Set(names)] };
}

fs.mkdirSync(out, { recursive: true });
const write = (f, v) => fs.writeFileSync(path.join(out, f), `${JSON.stringify(v, null, 1)}\n`);
write("icons.json", { pack: "icons", source: `lucide ${lucideVersion} (https://lucide.dev)`, license: "ISC", viewBox: "0 0 24 24", icons });
write("logos.json", { pack: "logos", source: `Simple Icons ${siPkg.version} (https://simpleicons.org)`, license: "CC0-1.0, except where an entry names MIT or Apache-2.0", viewBox: "0 0 24 24", note: "Brand names and logos belong to their owners. Shown only to name a technology (nominative use); no endorsement.", logos, skipped });
write("architecture.json", { pack: "architecture", source: "JobCairn, drawn with lucide icons (ISC)", license: "ISC", kinds: Object.fromEntries(Object.entries(ARCH).map(([k, [label, icon, tags]]) => [k, { label, icon, tags: tags.split(" ") }])) });
console.log(`icons ${Object.keys(icons).length}, logos ${Object.keys(logos).length}, architecture ${Object.keys(ARCH).length}; skipped logos: ${skipped.length}`);
for (const s of skipped) console.log(`  skipped ${s}`);
