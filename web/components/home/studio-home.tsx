import { InteractiveGrid } from "./interactive-grid";
import { MermaidArchitecture } from "./mermaid-architecture";
import styles from "./studio-home.module.css";

type SectionId =
  | "overview"
  | "capabilities"
  | "commands"
  | "mermaid"
  | "operations"
  | "contact";

interface TableRow {
  cells: [string, string, string];
  monoColumns?: number[];
}

const navItems: Array<{ label: string; section: SectionId }> = [
  { label: "Overview [A]", section: "overview" },
  { label: "Capabilities [B]", section: "capabilities" },
  { label: "Commands [C]", section: "commands" },
  { label: "Mermaid [D]", section: "mermaid" },
  { label: "Operations [E]", section: "operations" },
  { label: "Contact [F]", section: "contact" },
];

const platformBadges = [
  "GitHub App (Probot)",
  "GitHub Webhook",
  "GitLab Webhook",
  "OpenAI / Anthropic / Gemini",
];

const architectureRows: TableRow[] = [
  {
    cells: [
      "Ingress Layer",
      "NestJS controllers receive and validate webhook requests, then route to platform services.",
      "src/app.controller.ts + src/modules/*/webhook.controller.ts",
    ],
    monoColumns: [2],
  },
  {
    cells: [
      "Integration Layer",
      "GitHub/GitLab adapters fetch diffs, parse policy, and dispatch review or command flows.",
      "src/integrations/github/* + src/integrations/gitlab/*",
    ],
    monoColumns: [2],
  },
  {
    cells: [
      "Review Engine",
      "Patch parser, risk scoring, structured AI output validation, and markdown rendering.",
      "src/review/patch.ts + src/review/ai-reviewer.ts + src/review/report-renderer.ts",
    ],
    monoColumns: [2],
  },
];

const capabilityRows: TableRow[] = [
  {
    cells: [
      "Automatic PR/MR review",
      "Runs on opened/edited/synchronize/merged events with configurable comment/report mode.",
      "README Feature + Review Triggers",
    ],
  },
  {
    cells: [
      "Policy guardrails",
      "Checks issue/PR template completeness and supports remind/enforce policy mode via .mr-agent.yml.",
      "README Repository Policy",
    ],
  },
  {
    cells: [
      "Security + quality signals",
      "Secret pattern scanning, dedupe protection, feedback learning signals, and auto-labeling.",
      "src/integrations/github/github-review.ts",
    ],
    monoColumns: [2],
  },
  {
    cells: [
      "Process-aware review",
      "Detects changes in workflows/templates/CODEOWNERS/CONTRIBUTING and emits process-focused feedback.",
      "README Features + src/review/ai-reviewer.ts",
    ],
    monoColumns: [2],
  },
];

const triggerRows: TableRow[] = [
  {
    cells: [
      "PR opened / edited / synchronize",
      "Auto review in comment or report mode, based on repository policy.",
      "5 min dedupe window",
    ],
  },
  {
    cells: [
      "PR merged",
      "Always emits merged summary in report mode.",
      "24h dedupe window (configurable)",
    ],
  },
  {
    cells: [
      "Comment commands",
      "Manual trigger through /ai-review and specialized command surface.",
      "5 min dedupe window",
    ],
  },
  {
    cells: [
      "Issue/PR policy checks",
      "Runs pre-checks on issue and pull request events for template/process compliance.",
      "GitHub policy flow",
    ],
  },
];

const commandRows: TableRow[] = [
  { cells: ["/ai-review [report|comment]", "Manual review trigger", "Main command"] },
  { cells: ["/ask <question>", "Multi-turn Q&A on the changes", "Context-aware"] },
  { cells: ["/checks [question]", "Diagnose CI/check failures", "Failure triage"] },
  { cells: ["/generate_tests [focus]", "Generate test-plan and test-code draft", "Per file path"] },
  { cells: ["/describe [--apply]", "Generate or apply PR/MR description", "Policy-gated apply"] },
  { cells: ["/changelog [--apply]", "Generate or apply changelog entry", "Policy-gated apply"] },
  { cells: ["/improve [focus]", "Improvement-only review mode", "High-impact fixes"] },
  { cells: ["/add_doc [focus]", "Doc-only review suggestions", "Docstring/comment focus"] },
  { cells: ["/reflect [goal]", "Generate requirement clarifying questions", "Depends on ask"] },
  { cells: ["/similar_issue [query]", "Find related issues in the same repository", "Issue search"] },
  { cells: ["/feedback up|down|resolved|dismissed", "Record reviewer preference signal", "Future adaptation"] },
];

const endpointRows: TableRow[] = [
  { cells: ["GET /health", "Liveness and deep probe entry", "Supports ?deep=true"] },
  { cells: ["GET /metrics", "Prometheus text metrics export", "mr_agent_* series"] },
  { cells: ["GET /github/health", "GitHub webhook config status", "Secret readiness"] },
  { cells: ["GET /gitlab/health", "GitLab webhook config status", "Secret readiness"] },
  { cells: ["POST /github/trigger", "Plain GitHub webhook endpoint", "x-github-event"] },
  { cells: ["POST /gitlab/trigger", "GitLab webhook endpoint", "x-gitlab-event"] },
  { cells: ["GET /webhook/events", "List stored events (debug)", "Replay token required"] },
  { cells: ["POST /github/replay/:eventId", "Replay stored GitHub event", "Debug mode only"] },
  { cells: ["POST /gitlab/replay/:eventId", "Replay stored GitLab event", "Debug mode only"] },
];

const deploymentChecklist = [
  "Choose platform mode: GitHub App (recommended), plain GitHub webhook, optional GitLab webhook.",
  "Configure AI provider and model (openai/openai-compatible/anthropic/gemini).",
  "Use durable runtime state backend (sqlite recommended for production single-instance).",
  "Configure webhook URLs and secrets, then verify /health and platform health endpoints.",
  "Run test command flow in a real PR/MR comment thread before production rollout.",
];

const observabilityMetrics = [
  "mr_agent_webhook_requests_total",
  "mr_agent_webhook_results_total",
  "mr_agent_webhook_replay_total",
  "mr_agent_health_checks_total",
  "mr_agent_ai_requests_active",
  "mr_agent_ai_wait_queue_size",
];

const contactLinks = [
  {
    label: "GitHub",
    href: "https://github.com/condevtools/pr-agent",
    note: "Repository home",
  },
  {
    label: "Issue",
    href: "https://github.com/condevtools/pr-agent/issues",
    note: "Bug reports and feature requests",
  },
];

function PixelLogo() {
  const pattern = [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 1],
  ];

  return (
    <div className={styles.pixelLogo} aria-hidden>
      {pattern.flat().map((cell, index) => (
        <span
          key={index}
          className={`${styles.pixelLogoCell} ${
            cell ? styles.pixelLogoCellFilled : styles.pixelLogoCellEmpty
          }`}
        />
      ))}
    </div>
  );
}

function MatrixTable(props: { headers: [string, string, string]; rows: TableRow[] }) {
  const { headers, rows } = props;
  return (
    <div className={styles.tableWrap}>
      <div className={styles.tableHeader}>
        {headers.map((header) => (
          <div key={header} className={styles.tableHeaderCell}>
            {header}
          </div>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.cells.join("|")} className={styles.tableRow}>
          {row.cells.map((cell, index) => (
            <div
              key={`${row.cells[0]}-${index}`}
              className={`${styles.tableCell} ${
                row.monoColumns?.includes(index) ? styles.tableCellMono : ""
              }`}
            >
              {cell}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function MetaStats() {
  return (
    <div className={styles.metaGrid}>
      <div className={styles.metaCard}>
        <span className={styles.cardMeta}>PLATFORMS</span>
        <p className={styles.metricValue}>GitHub + GitLab</p>
      </div>
      <div className={styles.metaCard}>
        <span className={styles.cardMeta}>PROVIDERS</span>
        <p className={styles.metricValue}>OpenAI / Compatible / Claude / Gemini</p>
      </div>
      <div className={styles.metaCard}>
        <span className={styles.cardMeta}>TESTS</span>
        <p className={styles.metricValue}>24 Node test files</p>
      </div>
      <div className={styles.metaCard}>
        <span className={styles.cardMeta}>RUNTIME</span>
        <p className={styles.metricValue}>Node.js 22 + NestJS 11</p>
      </div>
    </div>
  );
}

export function StudioHome() {
  return (
    <div className={styles.home}>
      <InteractiveGrid />

      <nav className={styles.nav} aria-label="Primary sections">
        {navItems.map((item) => (
          <a key={item.section} className={styles.navLink} href={`#${item.section}`}>
            {item.label}
          </a>
        ))}
      </nav>

      <main className={styles.stage}>
        <section id="overview" className={`${styles.contentCard} ${styles.heroCard}`}>
          <PixelLogo />
          <span className={styles.cardMeta}>MR AGENT // TYPESCRIPT + NESTJS</span>
          <h1 className={styles.cardSectionTitle}>PR Agent</h1>
          <h2 className={styles.cardDisplayTitle}>
            AI-powered code review service for GitHub and GitLab pull/merge workflows.
          </h2>
          <p className={styles.cardBodyText}>
            PR Agent automates review comments and report summaries, parses diffs with line-aware
            mapping, applies repository policy guardrails, and exposes operational health/metrics
            endpoints for production monitoring.
          </p>
          <div className={styles.pillRow}>
            {platformBadges.map((badge) => (
              <span key={badge} className={styles.pill}>
                {badge}
              </span>
            ))}
          </div>
          <MetaStats />
        </section>

        <section className={`${styles.contentCard} ${styles.projectsCard}`}>
          <span className={styles.cardMeta}>ARCHITECTURE // EXECUTION LAYERS</span>
          <h1 className={styles.cardSectionTitle}>Pipeline Snapshot</h1>
          <MatrixTable
            headers={["Layer", "What It Does", "Primary Sources"]}
            rows={architectureRows}
          />
        </section>

        <section className={`${styles.contentCard} ${styles.methodCard}`}>
          <h1 className={styles.cardSectionTitle}>Runtime Highlights</h1>
          <ul className={styles.bulletList}>
            <li>Deduplication and incremental review state reduce repeated AI work.</li>
            <li>Command rate limits and webhook payload caps protect runtime stability.</li>
            <li>Structured error JSON and metrics endpoints support incident triage.</li>
            <li>Replay endpoints allow debug reprocessing when event-store mode is enabled.</li>
          </ul>
          <p className={styles.cardMonoLink}>DEFAULTS: PORT=3000 / WEBHOOK_BODY_LIMIT=1MB</p>
        </section>

        <section id="capabilities" className={`${styles.contentCard} ${styles.sectionCard}`}>
          <span className={styles.cardMeta}>CAPABILITIES // REVIEW + POLICY</span>
          <h1 className={styles.cardSectionTitle}>What PR Agent Handles</h1>
          <h2 className={styles.cardDisplayTitle}>
            Review automation, process checks, security hints, and workflow-aware feedback.
          </h2>
          <MatrixTable
            headers={["Capability", "Details", "Source"]}
            rows={capabilityRows}
          />
        </section>

        <section className={`${styles.contentCard} ${styles.sectionCard}`}>
          <span className={styles.cardMeta}>TRIGGERS // EVENT MATRIX</span>
          <h1 className={styles.cardSectionTitle}>Automatic + Manual Triggers</h1>
          <MatrixTable
            headers={["Trigger", "Behavior", "Dedup / Notes"]}
            rows={triggerRows}
          />
        </section>

        <section id="commands" className={`${styles.contentCard} ${styles.sectionCard}`}>
          <span className={styles.cardMeta}>COMMANDS // COMMENT INTERFACE</span>
          <h1 className={styles.cardSectionTitle}>Interactive Command Surface</h1>
          <h2 className={styles.cardDisplayTitle}>
            Operators can run review, ask questions, generate docs/tests, and feed back quality
            signals directly inside PR/MR discussions.
          </h2>
          <MatrixTable
            headers={["Command", "Purpose", "Notes"]}
            rows={commandRows.map((row) => ({ ...row, monoColumns: [0] }))}
          />
          <pre className={styles.codeBlock}>
            <code>{`/ai-review comment
/ask why this cache key can collide?
/checks flaky test on ci
/generate_tests diff parser edge cases
/changelog --apply release notes`}</code>
          </pre>
        </section>

        <section
          id="mermaid"
          className={`${styles.contentCard} ${styles.sectionCard} ${styles.mermaidSection}`}
        >
          <span className={styles.cardMeta}>MERMAID // ARCHITECTURE GRAPH</span>
          <h1 className={styles.cardSectionTitle}>Runtime Topology Diagram</h1>
          <h2 className={styles.cardDisplayTitle}>
            Event ingress, service dispatch, review engine, and platform API output path.
          </h2>
          <MermaidArchitecture />
        </section>

        <section id="operations" className={`${styles.contentCard} ${styles.contactCard}`}>
          <span className={styles.cardMeta}>OPERATIONS // DEPLOY + OBSERVE</span>
          <h1 className={styles.cardSectionTitle}>Run, Deploy, and Monitor</h1>
          <h2 className={styles.cardDisplayTitle}>
            Includes health checks, Prometheus metrics, replay tooling, and configurable runtime
            backends.
          </h2>

          <div className={styles.opsGrid}>
            <div className={styles.opsPanel}>
              <h3 className={styles.panelTitle}>Quick Start</h3>
              <pre className={styles.codeBlock}>
                <code>{`npm install
npm run dev
curl http://localhost:3000/health
curl http://localhost:3000/metrics`}</code>
              </pre>
            </div>
            <div className={styles.opsPanel}>
              <h3 className={styles.panelTitle}>Primary Endpoints</h3>
              <MatrixTable
                headers={["Endpoint", "Purpose", "Notes"]}
                rows={endpointRows.map((row) => ({ ...row, monoColumns: [0] }))}
              />
            </div>
          </div>

          <div className={styles.opsGrid}>
            <div className={styles.opsPanel}>
              <h3 className={styles.panelTitle}>Deployment Baseline</h3>
              <ul className={styles.bulletList}>
                {deploymentChecklist.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className={styles.opsPanel}>
              <h3 className={styles.panelTitle}>Prometheus Metrics</h3>
              <ul className={styles.bulletList}>
                {observabilityMetrics.map((metric) => (
                  <li key={metric}>
                    <code className={styles.inlineCode}>{metric}</code>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section id="contact" className={`${styles.contentCard} ${styles.methodCard}`}>
          <span className={styles.cardMeta}>CONTACT // COMMUNITY ENTRY</span>
          <h1 className={styles.cardSectionTitle}>Contact</h1>
          <ul className={styles.linkList}>
            {contactLinks.map((item) => (
              <li key={item.href}>
                <a
                  className={styles.externalLink}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {item.label}
                </a>
                <p className={styles.linkNote}>{item.note}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
