import { resolveRuntimeStateBackend } from "#core";
import { getAiConcurrencyStats } from "#review";

interface MetricDefinition {
  help: string;
  type: "counter" | "gauge";
}

interface MetricCounterRecord {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const metricDefinitions: Record<string, MetricDefinition> = {
  mr_agent_webhook_requests_total: {
    help: "Total number of received webhook trigger requests.",
    type: "counter",
  },
  mr_agent_webhook_results_total: {
    help: "Total number of webhook trigger outcomes.",
    type: "counter",
  },
  mr_agent_webhook_replay_total: {
    help: "Total number of webhook replay outcomes.",
    type: "counter",
  },
  mr_agent_webhook_store_writes_total: {
    help: "Total number of persisted webhook debug records.",
    type: "counter",
  },
  mr_agent_webhook_store_trim_total: {
    help: "Total number of webhook debug store trim operations.",
    type: "counter",
  },
  mr_agent_health_checks_total: {
    help: "Total number of health endpoint calls.",
    type: "counter",
  },
  mr_agent_http_errors_total: {
    help: "Total number of HTTP errors handled by global filter.",
    type: "counter",
  },
  mr_agent_process_uptime_seconds: {
    help: "Process uptime in seconds.",
    type: "gauge",
  },
  mr_agent_ai_requests_active: {
    help: "Number of active AI requests.",
    type: "gauge",
  },
  mr_agent_ai_wait_queue_size: {
    help: "Number of queued AI requests waiting for concurrency slots.",
    type: "gauge",
  },
  mr_agent_ai_shutdown_requested: {
    help: "Whether AI shutdown has been requested (1 or 0).",
    type: "gauge",
  },
  mr_agent_runtime_state_backend_info: {
    help: "Runtime state backend info metric (always 1 for selected backend).",
    type: "gauge",
  },
};

const metricCounters = new Map<string, MetricCounterRecord>();
let processStartedAt = Date.now();

export function incrementMetricCounter(
  name: string,
  labels: Record<string, string> = {},
  delta = 1,
): void {
  if (!Number.isFinite(delta) || delta === 0) {
    return;
  }

  const normalizedName = normalizeMetricName(name);
  const normalizedLabels = normalizeMetricLabels(labels);
  const key = buildCounterKey(normalizedName, normalizedLabels);
  const existing = metricCounters.get(key);
  if (existing) {
    existing.value += delta;
    return;
  }

  metricCounters.set(key, {
    name: normalizedName,
    labels: normalizedLabels,
    value: delta,
  });
}

export function renderPrometheusMetrics(): string {
  const lines: string[] = [];

  for (const [name, definition] of Object.entries(metricDefinitions)) {
    lines.push(`# HELP ${name} ${definition.help}`);
    lines.push(`# TYPE ${name} ${definition.type}`);

    if (definition.type === "counter") {
      const records = [...metricCounters.values()]
        .filter((record) => record.name === name)
        .sort((a, b) => buildCounterKey(a.name, a.labels).localeCompare(buildCounterKey(b.name, b.labels)));
      if (records.length === 0) {
        lines.push(formatMetricLine(name, 0, {}));
      } else {
        for (const record of records) {
          lines.push(formatMetricLine(name, record.value, record.labels));
        }
      }
      continue;
    }

    if (name === "mr_agent_process_uptime_seconds") {
      lines.push(formatMetricLine(name, (Date.now() - processStartedAt) / 1000, {}));
      continue;
    }

    if (name === "mr_agent_runtime_state_backend_info") {
      lines.push(
        formatMetricLine(name, 1, {
          backend: resolveRuntimeStateBackend(),
        }),
      );
      continue;
    }

    const ai = getAiConcurrencyStats();
    if (name === "mr_agent_ai_requests_active") {
      lines.push(formatMetricLine(name, ai.activeRequests, {}));
      continue;
    }
    if (name === "mr_agent_ai_wait_queue_size") {
      lines.push(formatMetricLine(name, ai.queuedRequests, {}));
      continue;
    }
    if (name === "mr_agent_ai_shutdown_requested") {
      lines.push(formatMetricLine(name, ai.shutdownRequested ? 1 : 0, {}));
      continue;
    }

    lines.push(formatMetricLine(name, 0, {}));
  }

  return `${lines.join("\n")}\n`;
}

export function __resetMetricsForTests(): void {
  metricCounters.clear();
  processStartedAt = Date.now();
}

export function __readMetricCounterForTests(
  name: string,
  labels: Record<string, string> = {},
): number {
  const key = buildCounterKey(normalizeMetricName(name), normalizeMetricLabels(labels));
  return metricCounters.get(key)?.value ?? 0;
}

function normalizeMetricName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    return "mr_agent_unknown_metric_total";
  }
  return normalized;
}

function normalizeMetricLabels(labels: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    const labelKey = key.trim();
    if (!labelKey) {
      continue;
    }
    normalized[labelKey] = value.trim();
  }
  return normalized;
}

function buildCounterKey(name: string, labels: Record<string, string>): string {
  const labelPairs = Object.entries(labels).sort((a, b) => a[0].localeCompare(b[0]));
  return `${name}|${labelPairs.map(([key, value]) => `${key}=${value}`).join(",")}`;
}

function formatMetricLine(
  name: string,
  value: number,
  labels: Record<string, string>,
): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  const labelPairs = Object.entries(labels).sort((a, b) => a[0].localeCompare(b[0]));
  if (labelPairs.length === 0) {
    return `${name} ${safeValue}`;
  }

  const renderedLabels = labelPairs
    .map(([key, labelValue]) => `${key}="${escapePrometheusLabelValue(labelValue)}"`)
    .join(",");
  return `${name}{${renderedLabels}} ${safeValue}`;
}

function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
