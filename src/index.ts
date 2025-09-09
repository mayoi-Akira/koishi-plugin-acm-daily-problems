import { Session } from "inspector/promises";
import { Context, Schema } from "koishi";

export const name = "acm-daily-problems";

export interface Config {}

export const Config: Schema<Config> = Schema.object({});

export function apply(ctx: Context) {
  ctx.command("test").action(({ session }) => {
    session.send("sb");
  });
}
