import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerOssTools } from './lib/tools.js';

export const name = 'oss-autopilot';
export const inject = ['tools'];

const SKILL_NAME = 'open-source-autopilot';

function loadSkill() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(path.join(here, 'skill', `${SKILL_NAME}.md`), 'utf8');
    return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  } catch {
    return undefined;
  }
}

/**
 * Register the Open Source Autopilot capability: model-facing tools, the
 * end-to-end contribution skill, and a short prompt nudge that points at both.
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  registerOssTools(ctx, config);

  const skill = loadSkill();
  const skills = ctx.get('skills');
  if (skills && skill) {
    try {
      ctx.effect(() => skills.register({
        name: SKILL_NAME,
        description: 'End-to-end GitHub contribution workflow: claim an issue, implement it, open a PR, respond to CI and reviews, and merge only when permitted.',
        whenToUse: 'Use when contributing to an open-source repository, claiming an issue, opening or shepherding a PR, or when the user asks to automate GitHub contributions.',
        content: skill,
        source: 'runtime',
        invocation: { modelInvocable: true, userInvocable: true },
        resourceBase: {
          kind: 'opaque',
          description: 'Bundled with the dsh-plugin-oss-autopilot package. Tool contracts are in the oss_* tool descriptions.',
        },
      }));
    } catch (error) {
      ctx.logger?.warn?.(`oss-autopilot: could not register skill: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt) {
    try {
      ctx.effect(() => systemPrompt.section({
        name: 'oss-autopilot',
        order: 2450,
        text: ({ scope }) => ctx.tools.get('oss_doctor', scope) === undefined
          ? ''
          : 'Open-source contribution work uses the open-source-autopilot skill and the oss_* tools. Load the skill before the first public action. Maintainers and repository policy are the authority: never claim that an issue was assigned, bypass checks or reviews, or merge without write permission.',
      }));
    } catch (error) {
      ctx.logger?.warn?.(`oss-autopilot: could not register prompt section: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
