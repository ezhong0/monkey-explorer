import { describe, it, expect } from 'vitest';
import { buildTrace } from './build-trace.js';

const baseHeader = {
  missionId: 'm1',
  mission: 'mission',
  target: 'https://app.example.com',
  startedAt: '2026-05-06T12:00:00.000Z',
  agentModel: 'anthropic/claude-opus-4-6',
};

describe('buildTrace — action description synthesis', () => {
  it('semantic act: "act(<arg>): <reasoning>"', () => {
    const trace = buildTrace({
      header: baseHeader,
      rawActions: [
        {
          type: 'act',
          reasoning: 'I want to click the deploy button',
          action: 'click the deploy button',
          pageUrl: 'https://app.example.com/foo',
          timeMs: 1,
        },
      ],
      consoleErrors: [],
      networkFailures: [],
    });
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0].type).toBe('action');
    if (trace.steps[0].type === 'action') {
      expect(trace.steps[0].action.description).toBe(
        'act("click the deploy button"): I want to click the deploy button',
      );
    }
  });

  it('semantic act with reasoning but no action arg: "act: <reasoning>"', () => {
    const trace = buildTrace({
      header: baseHeader,
      rawActions: [
        { type: 'goto', reasoning: 'navigating to homepage', timeMs: 1 },
      ],
      consoleErrors: [],
      networkFailures: [],
    });
    if (trace.steps[0].type === 'action') {
      expect(trace.steps[0].action.description).toBe('goto: navigating to homepage');
    }
  });

  it('pixel click with x/y: "click(540,320 button=left)"', () => {
    const trace = buildTrace({
      header: baseHeader,
      rawActions: [{ type: 'click', x: 540, y: 320, button: 'left', timeMs: 1 }],
      consoleErrors: [],
      networkFailures: [],
    });
    if (trace.steps[0].type === 'action') {
      expect(trace.steps[0].action.description).toContain('click(');
      expect(trace.steps[0].action.description).toContain('540,320');
    }
  });

  it('pixel type: type("text")', () => {
    const trace = buildTrace({
      header: baseHeader,
      rawActions: [{ type: 'type', text: 'hello world', timeMs: 1 }],
      consoleErrors: [],
      networkFailures: [],
    });
    if (trace.steps[0].type === 'action') {
      expect(trace.steps[0].action.description).toBe('type("hello world")');
    }
  });

  it('long type text gets truncated', () => {
    const longText = 'x'.repeat(200);
    const trace = buildTrace({
      header: baseHeader,
      rawActions: [{ type: 'type', text: longText, timeMs: 1 }],
      consoleErrors: [],
      networkFailures: [],
    });
    if (trace.steps[0].type === 'action') {
      expect(trace.steps[0].action.description).toContain('…');
      expect(trace.steps[0].action.description.length).toBeLessThan(120);
    }
  });

  it('dragAndDrop: (fromX,fromY)→(toX,toY)', () => {
    const trace = buildTrace({
      header: baseHeader,
      rawActions: [
        { type: 'dragAndDrop', fromX: 10, fromY: 20, toX: 100, toY: 200, timeMs: 1 },
      ],
      consoleErrors: [],
      networkFailures: [],
    });
    if (trace.steps[0].type === 'action') {
      expect(trace.steps[0].action.description).toContain('(10,20)');
      expect(trace.steps[0].action.description).toContain('(100,200)');
    }
  });

  it('goto with url shows the url', () => {
    const trace = buildTrace({
      header: baseHeader,
      rawActions: [{ type: 'goto', url: 'https://app.example.com/foo', timeMs: 1 }],
      consoleErrors: [],
      networkFailures: [],
    });
    if (trace.steps[0].type === 'action') {
      expect(trace.steps[0].action.description).toContain('https://app.example.com/foo');
    }
  });

  it('screenshot: "screenshot()"', () => {
    const trace = buildTrace({
      header: baseHeader,
      rawActions: [{ type: 'screenshot', timeMs: 1 }],
      consoleErrors: [],
      networkFailures: [],
    });
    if (trace.steps[0].type === 'action') {
      expect(trace.steps[0].action.description).toBe('screenshot()');
    }
  });
});

describe('buildTrace — event correlation', () => {
  it('buckets console events into the step whose timestamp window covers them', () => {
    const trace = buildTrace({
      header: baseHeader,
      rawActions: [
        { type: 'act', reasoning: 'first', action: 'a', timeMs: 1000 },
        { type: 'act', reasoning: 'second', action: 'b', timeMs: 3000 },
      ],
      consoleErrors: [
        {
          level: 'error',
          message: 'oops',
          timestamp: new Date(2000).toISOString(), // between t=1000 and t=3000
        },
      ],
      networkFailures: [],
    });
    expect(trace.steps).toHaveLength(2);
    if (trace.steps[0].type === 'action') {
      expect(trace.steps[0].consoleEvents).toHaveLength(1);
    }
    if (trace.steps[1].type === 'action') {
      expect(trace.steps[1].consoleEvents).toHaveLength(0);
    }
  });
});

describe('buildTrace — past-the-end safety (regression)', () => {
  it('handles single-action trace without sortedActions[i+1] crash', () => {
    // Regression: actionTime(undefined) used to throw "Cannot read
    // properties of undefined (reading 'timeMs')" on the past-the-end
    // lookup. Verify the fix is in place.
    expect(() =>
      buildTrace({
        header: baseHeader,
        rawActions: [{ type: 'screenshot', timeMs: 1 }],
        consoleErrors: [],
        networkFailures: [],
      }),
    ).not.toThrow();
  });

  it('handles empty rawActions', () => {
    const trace = buildTrace({
      header: baseHeader,
      rawActions: [],
      consoleErrors: [],
      networkFailures: [],
    });
    expect(trace.steps).toHaveLength(0);
  });

  it('drops malformed actions silently (Zod safeParse)', () => {
    const trace = buildTrace({
      header: baseHeader,
      rawActions: [
        null, // not an object
        'not an action', // not an object
        { type: 'click', x: 1, y: 2, timeMs: 1 }, // valid
      ],
      consoleErrors: [],
      networkFailures: [],
    });
    expect(trace.steps).toHaveLength(1);
  });
});
