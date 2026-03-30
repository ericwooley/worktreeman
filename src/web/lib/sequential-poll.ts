type SequentialPollOptions = {
  intervalMs: number;
  runImmediately?: boolean;
};

type SequentialPollController = {
  trigger: () => void;
  stop: () => void;
};

export function startSequentialPoll(
  callback: () => void | Promise<void>,
  options: SequentialPollOptions,
): SequentialPollController {
  const { intervalMs, runImmediately = false } = options;

  let timeoutId: number | null = null;
  let stopped = false;
  let running = false;
  let rerunRequested = false;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }

    timeoutId = window.setTimeout(() => {
      void run();
    }, intervalMs);
  };

  const run = async () => {
    if (stopped) {
      return;
    }

    if (running) {
      rerunRequested = true;
      return;
    }

    running = true;
    try {
      await callback();
    } finally {
      running = false;

      if (stopped) {
        return;
      }

      if (rerunRequested) {
        rerunRequested = false;
        void run();
        return;
      }

      scheduleNext();
    }
  };

  const trigger = () => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }

    void run();
  };

  if (runImmediately) {
    trigger();
  } else {
    scheduleNext();
  }

  return {
    trigger,
    stop: () => {
      stopped = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    },
  };
}
