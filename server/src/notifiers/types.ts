import type { HilRequest, Task } from '@sdlc/shared';

export interface Notifier {
  readonly name: string;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  test?(): Promise<void>;
  onHilCreated(req: HilRequest, task: Task, link: string): Promise<void>;
  onHilAnswered?(req: HilRequest, task: Task): Promise<void>;
  onTaskStatus?(task: Task, from: string, to: string, link: string): Promise<void>;
  onError?(taskId: string | undefined, message: string): Promise<void>;
}
