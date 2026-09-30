import { Router, type IRouter } from "express";
import { GetTelemetrySnapshotResponse } from "@workspace/api-zod";
import { getTelemetrySnapshot } from "../lib/telemetry";

const router: IRouter = Router();

router.get("/telemetry/snapshot", (_req, res) => {
  const snapshot = GetTelemetrySnapshotResponse.parse(getTelemetrySnapshot());
  res.json(snapshot);
});

export default router;