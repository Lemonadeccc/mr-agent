"use client";

import { useEffect, useState } from "react";
import styles from "./studio-home.module.css";

const MERMAID_SRC = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

const diagram = `flowchart LR
    subgraph E["Entry Endpoints (NestJS + Probot)"]
        E1["/api/github/webhooks<br/>GithubAppBootstrapService"]
        E2["/github/trigger<br/>GithubWebhookController"]
        E3["/gitlab/trigger<br/>GitlabWebhookController"]
        E4["/github/replay/:eventId<br/>/gitlab/replay/:eventId"]
        E5["/health /metrics /webhook/events"]
    end

    subgraph GHA["GitHub App Event Routing (src/app.ts)"]
        A1["issues.opened, issues.edited<br/>runGitHubIssuePolicyCheck"]
        A2["pull_request.opened, edited, synchronize<br/>runGitHubPullRequestPolicyCheck"]
        A3["resolveGitHubPullRequestAutoReviewPolicy"]
        A4["pull_request.closed (merged)<br/>resolveGitHubReviewBehaviorPolicy"]
        A5["issue_comment.created (PR only)<br/>handleGitHubIssueCommentCommand"]
        A6["pull_request_review_thread<br/>recordGitHubFeedbackSignal"]
    end

    subgraph GHW["Plain GitHub Webhook (src/integrations/github/github-webhook.ts)"]
        B1["handlePlainGitHubWebhook"]
        B2["verifyWebhookSignature + payload schema"]
        B3["pull_request / issues / issue_comment / review_thread dispatch"]
        B4["runGitHubPullRequestPolicyCheck + runGitHubIssuePolicyCheck"]
        B5["handleGitHubIssueCommentCommand"]
    end

    subgraph GLW["GitLab Webhook (src/integrations/gitlab/gitlab-review.ts)"]
        C1["runGitLabWebhook"]
        C2["verify token + payload schema"]
        C3["handleGitLabMergeRequestWebhook"]
        C4["handleGitLabNoteWebhook"]
        C5["resolveGitLabReviewPolicy (.mr-agent.yml)"]
    end

    subgraph CMD["Command Parsing Surface"]
        D1["parseReviewCommand"]
        D2["parseAsk / parseChecks / parseGenerateTests"]
        D3["parseDescribe / parseChangelog"]
        D4["parseImprove / parseAddDoc / parseReflect / parseSimilarIssue / parseFeedback"]
    end

    subgraph CORE["Common Review Engine"]
        R1["runGitHubReview / runGitLabReview"]
        R2["dedupe + rate-limit + incremental head + feedback signals"]
        R3["collect context: diff/files/ci/policy"]
        R4["analyzePullRequest / answerPullRequestQuestion"]
        R5["patch parser + hunk prioritize + line mapping"]
        R6["secret scan + auto label"]
    end

    subgraph OUT["Output + Ops"]
        O1["buildReportCommentMarkdown"]
        O2["buildIssueCommentMarkdown"]
        O3["createComment / notes / managed upsert"]
        O4["publishNotification (optional)"]
        O5["mr_agent_* metrics + replay store"]
    end

    E1 --> A1
    E1 --> A2 --> A3 --> R1
    E1 --> A4 --> R1
    E1 --> A5
    E1 --> A6

    E2 --> B1 --> B2 --> B3
    B3 --> B4 --> R1
    B3 --> B5

    E3 --> C1 --> C2
    C2 --> C3 --> C5 --> R1
    C2 --> C4 --> C5

    A5 --> D1
    A5 --> D2
    A5 --> D3
    A5 --> D4
    B5 --> D1
    B5 --> D2
    B5 --> D3
    B5 --> D4
    C4 --> D1
    C4 --> D2
    C4 --> D3
    C4 --> D4

    D1 --> R1
    D2 --> R4
    D3 --> R4
    D4 --> R1

    R1 --> R2 --> R3 --> R4 --> R5
    R4 --> R6
    R5 --> O1 --> O3
    R5 --> O2 --> O3
    R6 --> O3
    O3 --> O4

    E4 --> B1
    E4 --> C1
    E5 --> O5
    E2 --> O5
    E3 --> O5
    O3 -. feedback signals .-> R2

    classDef entry fill:#111111,color:#ffffff,stroke:#111111,stroke-width:1px;
    classDef route fill:#f3f3f3,color:#111111,stroke:#111111,stroke-width:1px;
    classDef core fill:#ffffff,color:#111111,stroke:#111111,stroke-width:1.5px;
    classDef out fill:#ededed,color:#111111,stroke:#111111,stroke-width:1px;

    class E1,E2,E3,E4,E5 entry;
    class A1,A2,A3,A4,A5,A6,B1,B2,B3,B4,B5,C1,C2,C3,C4,C5,D1,D2,D3,D4 route;
    class R1,R2,R3,R4,R5,R6 core;
    class O1,O2,O3,O4,O5 out;`;

interface MermaidWindow extends Window {
  mermaid?: {
    initialize: (config: Record<string, unknown>) => void;
    run: (options?: { nodes?: Element[] }) => Promise<void> | void;
  };
}

export function MermaidArchitecture() {
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    let cancelled = false;
    const win = window as MermaidWindow;

    const render = async () => {
      if (!win.mermaid || cancelled) {
        return;
      }

      try {
        win.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: "base",
          themeVariables: {
            fontFamily: "Courier New, Courier, monospace",
            primaryColor: "#f7f7f7",
            primaryBorderColor: "#1a1a1a",
            lineColor: "#1a1a1a",
            textColor: "#111111",
            clusterBkg: "#ffffff",
            clusterBorder: "#1a1a1a",
          },
        });

        const host = document.getElementById("mr-agent-mermaid");
        if (!host) {
          return;
        }
        host.removeAttribute("data-processed");
        await win.mermaid.run({ nodes: [host] });
        setError(null);
      } catch (renderError) {
        setError(
          renderError instanceof Error
            ? renderError.message
            : "Failed to render mermaid diagram.",
        );
      }
    };

    const handleLoad = () => {
      void render();
    };

    const handleError = () => {
      setError("Mermaid script failed to load.");
    };

    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-mermaid-loader="true"]',
    );
    if (existing) {
      if (win.mermaid) {
        void render();
      } else {
        existing.addEventListener("load", handleLoad, { once: true });
        existing.addEventListener("error", handleError, { once: true });
      }
      return () => {
        cancelled = true;
        existing.removeEventListener("load", handleLoad);
        existing.removeEventListener("error", handleError);
      };
    }

    const script = document.createElement("script");
    script.src = MERMAID_SRC;
    script.async = true;
    script.dataset.mermaidLoader = "true";
    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
    document.body.appendChild(script);

    return () => {
      cancelled = true;
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
  }, []);

  return (
    <div className={styles.mermaidPanel}>
      <div className={styles.mermaidToolbar}>
        <button
          type="button"
          className={styles.mermaidToolButton}
          onClick={() => {
            setScale((previous) => Math.min(2.4, Number((previous + 0.1).toFixed(2))));
          }}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className={styles.mermaidToolButton}
          onClick={() => {
            setScale((previous) => Math.max(0.6, Number((previous - 0.1).toFixed(2))));
          }}
          aria-label="Zoom out"
        >
          -
        </button>
        <button
          type="button"
          className={styles.mermaidToolButton}
          onClick={() => {
            setScale(1);
            setOffset({ x: 0, y: 0 });
          }}
          aria-label="Reset view"
        >
          Reset
        </button>
        <span className={styles.mermaidZoomText}>{Math.round(scale * 100)}%</span>

        <button
          type="button"
          className={styles.mermaidToolButton}
          onClick={() => setOffset((previous) => ({ ...previous, y: previous.y - 30 }))}
          aria-label="Move up"
        >
          ↑
        </button>
        <button
          type="button"
          className={styles.mermaidToolButton}
          onClick={() => setOffset((previous) => ({ ...previous, x: previous.x - 30 }))}
          aria-label="Move left"
        >
          ←
        </button>
        <button
          type="button"
          className={styles.mermaidToolButton}
          onClick={() => setOffset((previous) => ({ ...previous, y: previous.y + 30 }))}
          aria-label="Move down"
        >
          ↓
        </button>
        <button
          type="button"
          className={styles.mermaidToolButton}
          onClick={() => setOffset((previous) => ({ ...previous, x: previous.x + 30 }))}
          aria-label="Move right"
        >
          →
        </button>
      </div>

      <div className={styles.mermaidViewport}>
        <div
          className={styles.mermaidCanvas}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        >
          <div id="mr-agent-mermaid" className={`mermaid ${styles.mermaidHost}`}>
            {diagram}
          </div>
        </div>
      </div>
      {error ? <p className={styles.mermaidError}>Mermaid error: {error}</p> : null}
    </div>
  );
}
