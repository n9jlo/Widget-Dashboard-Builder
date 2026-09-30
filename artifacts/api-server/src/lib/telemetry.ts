import type { TelemetrySnapshot, TelemetrySource } from "@workspace/api-zod";

const initialSources: TelemetrySource[] = [
  {
    key: "cpu",
    label: "CPU usage",
    unit: "%",
    value: 38.4,
    min: 0,
    max: 100,
    status: "active",
    history: [33, 36, 34, 41, 38, 43, 39, 37, 42, 38],
  },
  {
    key: "memory",
    label: "Memory",
    unit: "%",
    value: 67.2,
    min: 0,
    max: 100,
    status: "active",
    history: [63, 65, 64, 68, 66, 70, 68, 69, 66, 67],
  },
  {
    key: "requests",
    label: "Requests / min",
    unit: "req/min",
    value: 1248,
    min: 0,
    max: 2500,
    status: "active",
    history: [1120, 1180, 1104, 1320, 1410, 1290, 1364, 1210, 1278, 1248],
  },
  {
    key: "latency",
    label: "Response latency",
    unit: "ms",
    value: 142,
    min: 0,
    max: 500,
    status: "active",
    history: [136, 148, 129, 155, 163, 138, 145, 131, 150, 142],
  },
  {
    key: "errors",
    label: "Error rate",
    unit: "%",
    value: 0.24,
    min: 0,
    max: 5,
    status: "active",
    history: [0.18, 0.22, 0.16, 0.31, 0.28, 0.2, 0.34, 0.27, 0.21, 0.24],
  },
];

let sources = initialSources.map((source) => ({ ...source }));

export function getTelemetrySnapshot(): TelemetrySnapshot {
  return {
    generatedAt: new Date(),
    sources: sources.map((source) => ({
      ...source,
      history: [...source.history],
    })),
  };
}

export function advanceTelemetry(): TelemetrySource[] {
  sources = sources.map((source, index) => {
    const scale = Math.max((source.max - source.min) * 0.035, 0.02);
    const change = (Math.random() - 0.5) * scale;
    const nextValue = Math.min(
      source.max,
      Math.max(source.min, source.value + change),
    );
    const value =
      source.key === "requests"
        ? Math.round(nextValue)
        : Number(nextValue.toFixed(index === 4 ? 2 : 1));

    return {
      ...source,
      value,
      status: source.key === "errors" && value > 1 ? "warning" : "active",
      history: [...source.history.slice(-23), value],
    };
  });

  return sources.map((source) => ({
    ...source,
    history: [...source.history],
  }));
}