/**
 * Config: the skills Learn looks for in saved job ads to suggest study topics.
 *
 * Keep this list small and plain. Each entry is the label people see and the words that count
 * as a mention (matched case-insensitively, as whole words). Add an entry here to teach Learn a
 * new skill; no code changes needed.
 *
 * Some words mean something else in plain English ("recruitment agents", "react quickly",
 * "shipping containers", "monitoring progress"). Put those in `weak`: they count only when one of
 * the entry's `context` words is close by (within CONTEXT_WINDOW characters).
 */
export interface SkillKeyword {
  label: string;
  aliases: readonly string[];
  /** Ambiguous words that count only near a `context` word. */
  weak?: readonly string[];
  context?: readonly string[];
}

/** How far (in characters, either side) a weak word looks for a context word. */
export const CONTEXT_WINDOW = 60;

export const SKILL_KEYWORDS: readonly SkillKeyword[] = [
  { label: "Python", aliases: ["python"] },
  { label: "TypeScript", aliases: ["typescript"] },
  { label: "Node.js", aliases: ["node.js", "nodejs"] },
  { label: "Go", aliases: ["golang"] },
  { label: "Java", aliases: ["java"] },
  { label: "SQL", aliases: ["sql", "postgres", "postgresql", "mysql"] },
  {
    label: "React", aliases: ["react.js", "reactjs", "react native"], weak: ["react"],
    context: ["javascript", "typescript", "js", "frontend", "front-end", "front end", "redux", "next.js", "nextjs", "vue", "angular", "hooks", "components", "ui", "web"],
  },
  { label: "REST APIs", aliases: ["rest api", "rest apis", "restful"] },
  { label: "GraphQL", aliases: ["graphql"] },
  {
    label: "Docker", aliases: ["docker", "containerisation", "containerization", "containerised", "containerized"], weak: ["containers"],
    context: ["kubernetes", "k8s", "ecs", "eks", "aks", "cloud", "devops", "orchestration", "podman", "deploy", "deployment", "microservices"],
  },
  { label: "Kubernetes", aliases: ["kubernetes", "k8s"] },
  { label: "Terraform", aliases: ["terraform", "infrastructure as code"] },
  { label: "AWS", aliases: ["aws", "amazon web services"] },
  { label: "Azure", aliases: ["azure"] },
  { label: "Google Cloud", aliases: ["gcp", "google cloud"] },
  { label: "CI/CD", aliases: ["ci/cd", "continuous integration", "github actions"] },
  { label: "System design", aliases: ["system design", "distributed systems", "scalable systems"] },
  { label: "Microservices", aliases: ["microservices", "microservice"] },
  { label: "Kafka", aliases: ["kafka", "event streaming"] },
  { label: "Machine learning", aliases: ["machine learning", "ml"] },
  { label: "LLMs", aliases: ["llm", "llms", "large language model", "large language models"] },
  { label: "RAG pipelines", aliases: ["rag", "retrieval-augmented", "retrieval augmented", "retrieval pipelines"] },
  { label: "Vector databases", aliases: ["vector database", "vector databases", "pgvector", "embeddings"] },
  {
    label: "AI agents", aliases: ["agentic", "ai agents", "ai agent", "llm agents", "autonomous agents", "multi-agent"], weak: ["agents", "agent"],
    context: ["ai", "llm", "llms", "gpt", "claude", "langchain", "langgraph", "autonomous", "tool use", "tool calling", "openai", "model", "models"],
  },
  { label: "Prompt engineering", aliases: ["prompt engineering", "prompting"] },
  { label: "LLM evaluation", aliases: ["evals", "llm evaluation", "model evaluation"] },
  { label: "PyTorch", aliases: ["pytorch"] },
  { label: "MLOps", aliases: ["mlops", "model deployment"] },
  {
    label: "Observability", aliases: ["observability", "opentelemetry", "prometheus", "grafana", "datadog"], weak: ["monitoring"],
    context: ["logging", "logs", "metrics", "tracing", "alerting", "alerts", "production", "systems", "infrastructure", "sre", "on-call", "uptime", "services"],
  },
  { label: "Application security", aliases: ["application security", "secure coding", "owasp"] },
  { label: "Testing", aliases: ["unit testing", "test automation", "tdd"] },
  { label: "Agile", aliases: ["agile", "scrum"] },
];
