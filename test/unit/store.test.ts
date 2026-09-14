import { describe, it, expect } from 'vitest';
import { openDb } from '../../server/src/store/db.js';
import { Store } from '../../server/src/store/repo.js';
import { EventBus } from '../../server/src/store/events.js';

describe('Store + EventBus', () => {
  it('round-trips a task and replays events', () => {
    const db = openDb(':memory:');
    const store = new Store(db);
    const now = new Date().toISOString();
    store.insertTask({ id: 't_1', title: 'x', initialPrompt: 'p', refinedPrompt: null, repoPath: '/r', repoSlug: null, baseRemote: 'origin', baseBranch: 'main', branch: 'sdlc/t_1', worktreePath: '/w', pipelineName: 'auto', reviewMode: 'conceptual', postReview: false, status: 'created', totalCostUsd: 0, prUrl: null, prNumber: null, prFeedbackCursor: null, createdAt: now, updatedAt: now });
    const t = store.getTask('t_1')!;
    expect(t.baseRemote).toBe('origin');
    t.status = 'running'; t.totalCostUsd = 1.5; store.updateTask(t);
    expect(store.listTasks(['running'])[0]!.totalCostUsd).toBe(1.5);
    const bus = new EventBus(db);
    const got: string[] = [];
    bus.on((e) => got.push(e.type));
    bus.emit('task.cost', { taskId: 't_1', totalCostUsd: 1 }, { taskId: 't_1' });
    bus.emit('engine.warning', { message: 'w' });
    expect(got).toEqual(['task.cost', 'engine.warning']);
    expect(bus.replay(0).length).toBe(2);
    expect(bus.replay(1, 't_1').length).toBe(0);
    expect(bus.replay(0, 't_1').length).toBe(1);
  });
});
