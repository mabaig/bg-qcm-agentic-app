require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { executeTool } = require('./executor');
const { toolDefinitions } = require('./tools');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// System prompt used in Phase 1 (planning — no tools called)
const PLAN_SYSTEM = `You are an enterprise warehouse quality operations agent for a Quality Case Management (QCM) system.

Your available tools are:
- get_quality_cases: Retrieve quality cases (filter by number, type, status, facility)
- create_quality_case: Create a new quality case [WRITE]
- get_case_types: Get all case type options with IDs
- get_reason_codes: Get all reason codes with severity
- lock_inventory: Lock inventory via WMS — links a case to locked inventory [WRITE, CRITICAL]
- unlock_inventory: Unlock inventory via WMS [WRITE, CRITICAL]
- get_case_lock_mappings: Get current inventory locks linked to cases
- get_case_audit: Get audit trail — status changes, reassignments
- get_lock_audit: Get lock/unlock history

OUTPUT a step-by-step plan in EXACTLY this format and STOP — do NOT call any tools yet:

PLAN:
1. [tool_name]: Brief description of what and why
2. [tool_name]: Brief description of what and why
(add as many steps as needed)

IMPACT: One sentence describing what data will change or what will be queried.
REQUIRES_CONFIRMATION: YES if any step creates, modifies, locks, or unlocks data. NO if all steps are read-only.

Rules:
- Always query before acting: if you need IDs (caseTypeId, caseId), plan a lookup step first
- For bulk operations, plan a query step first so you know the count before confirming
- Be specific in step descriptions — include what values you'll filter by`;

// System prompt used in Phase 2 (execution — tools enabled)
const EXEC_SYSTEM = `You are an enterprise warehouse quality operations agent. The user has confirmed the plan. Execute it now using the provided tools.

Rules:
- Execute steps in order
- After each tool call, acknowledge the result briefly
- If a step fails, report it and continue with remaining steps if possible
- At the very end, output a summary starting with "SUMMARY:" that includes:
  - What was done
  - Success/failure count
  - Any case numbers or lock IDs created
  - Any errors encountered`;

function parsePlan(text) {
  const steps = [];
  const planSection = text.match(/PLAN:\n([\s\S]*?)(?:IMPACT:|REQUIRES_CONFIRMATION:|$)/);
  if (!planSection) return steps;

  const lines = planSection[1].split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\.\s+\[([^\]]+)\]:\s*(.+)/);
    if (m) {
      steps.push({
        index: parseInt(m[1]),
        tool: m[2].trim(),
        description: m[3].trim(),
        status: 'pending',
      });
    }
  }
  return steps;
}

function extractField(text, label) {
  const m = text.match(new RegExp(`${label}:\\s*(.+?)(?:\\n|$)`, 'i'));
  return m ? m[1].trim() : '';
}

async function runAgent(session, sessionId, sendEvent) {
  const messages = [...session.messages];

  // ─── Phase 1: Generate plan (no tools) ───────────────────────────────────
  sendEvent('status', { status: 'planning', message: 'Analyzing your request...' });

  const planRes = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: PLAN_SYSTEM,
        cache_control: { type: 'ephemeral' },
      },
    ],
    // No tools — force text-only response
    messages,
  });

  const planText = planRes.content.find(c => c.type === 'text')?.text || '';
  const planSteps = parsePlan(planText);
  const impact = extractField(planText, 'IMPACT');
  const requiresConfirmation = /REQUIRES_CONFIRMATION:\s*YES/i.test(planText);

  sendEvent('plan', { steps: planSteps, impact, rawText: planText });

  messages.push({ role: 'assistant', content: planText });

  // ─── Confirmation gate ───────────────────────────────────────────────────
  if (requiresConfirmation) {
    const promise = new Promise(resolve => {
      session.pendingConfirmation = { resolve };
    });

    sendEvent('confirmation_required', {
      message: impact || 'This operation will modify data.',
      steps: planSteps,
    });

    const confirmed = await promise;
    if (!confirmed) {
      messages.push({ role: 'user', content: 'CANCEL — operation cancelled by user.' });
      sendEvent('cancelled', { message: 'Operation cancelled.' });
      session.status = 'cancelled';
      session.messages = messages;
      return;
    }
    messages.push({ role: 'user', content: 'CONFIRMED — please execute the plan now.' });
  } else {
    messages.push({ role: 'user', content: 'PROCEED — execute the plan.' });
  }

  // ─── Phase 2: Execute ────────────────────────────────────────────────────
  sendEvent('status', { status: 'executing', message: 'Executing plan...' });

  let stepIndex = 0;
  const stats = { success: 0, failed: 0 };

  while (true) {
    const execRes = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: EXEC_SYSTEM,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: toolDefinitions,
      messages,
    });

    const toolCalls = execRes.content.filter(c => c.type === 'tool_use');
    const textBlock = execRes.content.find(c => c.type === 'text');

    if (toolCalls.length === 0) {
      const finalText = textBlock?.text || 'Execution complete.';
      const summaryMatch = finalText.match(/SUMMARY:([\s\S]*)/i);
      sendEvent('complete', {
        message: finalText,
        summary: summaryMatch ? summaryMatch[1].trim() : finalText,
        stats,
      });
      session.status = 'complete';
      messages.push({ role: 'assistant', content: execRes.content });
      session.messages = messages;
      break;
    }

    const toolResults = [];

    for (const toolCall of toolCalls) {
      stepIndex++;

      // Match this tool call to a plan step
      const planStepIdx = planSteps.findIndex(s => s.tool === toolCall.name && s.status === 'pending');
      if (planStepIdx >= 0) {
        planSteps[planStepIdx].status = 'running';
        sendEvent('plan_step_update', { index: planStepIdx, status: 'running' });
      }

      sendEvent('step_start', {
        stepIndex,
        toolName: toolCall.name,
        payload: toolCall.input,
        id: toolCall.id,
      });

      try {
        const result = await executeTool(toolCall.name, toolCall.input);
        stats.success++;

        if (planStepIdx >= 0) {
          planSteps[planStepIdx].status = 'success';
          sendEvent('plan_step_update', { index: planStepIdx, status: 'success' });
        }

        sendEvent('step_complete', {
          stepIndex,
          toolName: toolCall.name,
          result,
          resultSummary: buildResultSummary(toolCall.name, result),
          status: 'success',
          id: toolCall.id,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        stats.failed++;

        if (planStepIdx >= 0) {
          planSteps[planStepIdx].status = 'failed';
          sendEvent('plan_step_update', { index: planStepIdx, status: 'failed' });
        }

        sendEvent('step_error', {
          stepIndex,
          toolName: toolCall.name,
          error: err.message,
          status: 'failed',
          id: toolCall.id,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: `Error: ${err.message}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'assistant', content: execRes.content });
    messages.push({ role: 'user', content: toolResults });
    session.messages = messages;
  }
}

function buildResultSummary(toolName, result) {
  if (!result) return 'No response';
  switch (toolName) {
    case 'get_quality_cases':
      return `Retrieved ${result.items?.length ?? 0} quality case(s)`;
    case 'create_quality_case':
      return `Case created: ${result.caseNumber || result.caseId || 'unknown'}`;
    case 'get_case_types':
      return `Found ${result.items?.length ?? 0} case type(s)`;
    case 'get_reason_codes':
      return `Found ${result.items?.length ?? 0} reason code(s)`;
    case 'lock_inventory':
      return `Lock applied — ${result.message || result.statusCode || result.wmsApiResponse || 'done'}`;
    case 'unlock_inventory':
      return `Unlock applied — ${result.message || result.statusCode || 'done'}`;
    case 'get_case_lock_mappings':
      return `Found ${result.items?.length ?? 0} lock mapping(s)`;
    case 'get_case_audit':
      return `Found ${result.items?.length ?? 0} audit record(s)`;
    case 'get_lock_audit':
      return `Found ${result.items?.length ?? 0} lock audit record(s)`;
    default:
      if (result.items) return `Retrieved ${result.items.length} record(s)`;
      if (result.message) return result.message;
      return 'Completed';
  }
}

module.exports = { runAgent };
