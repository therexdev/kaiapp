"use strict";
const { CronExpressionParser } = require("cron-parser");
const { computeNext } = require("../core/lib/tasks");
const { CompanionError } = require("./companion-store");
function next(schedule, now = Date.now()) {
  if (!schedule || schedule.kind === "manual") return null;
  if (schedule.kind === "at") { const at = Date.parse(schedule.at); if (!Number.isFinite(at)) throw new CompanionError("Choose a valid date and time."); return at > now ? new Date(at).toISOString() : null; }
  if (schedule.kind === "interval") { const minutes = Number(schedule.minutes); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new CompanionError("Choose an interval of 1–10,080 minutes."); return new Date(now + minutes * 60000).toISOString(); }
  if (["hourly", "every6h"].includes(schedule.kind)) return computeNext(schedule, new Date(now)).toISOString();
  let expression = schedule.expression;
  if (["daily", "weekly"].includes(schedule.kind)) {
    const hour = Number(schedule.hour ?? 9), minute = Number(schedule.minute ?? 0), day = Number(schedule.day ?? 1);
    if (![hour, minute, day].every(Number.isInteger) || hour < 0 || hour > 23 || minute < 0 || minute > 59 || day < 0 || day > 6) throw new CompanionError("Check the schedule's hour, minute and day.");
    expression = `${minute} ${hour} * * ${schedule.kind === "weekly" ? day : "*"}`;
  } else if (schedule.kind !== "cron") throw new CompanionError("Choose a supported schedule.");
  if (typeof expression !== "string" || expression.length > 120 || expression.trim().split(/\s+/).length !== 5) throw new CompanionError("Use a five-field cron expression: minute hour day month weekday.");
  try { return CronExpressionParser.parse(expression, { currentDate: new Date(now), ...(schedule.timezone ? { tz: schedule.timezone } : {}) }).next().toISOString(); }
  catch { throw new CompanionError("Check the cron expression and time zone."); }
}
module.exports = { next };
