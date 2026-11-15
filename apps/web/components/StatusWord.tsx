import { stateTone, stateWord } from '@/lib/format';

/**
 * The state vocabulary as one component: the word carries the meaning, the
 * swatch repeats it in a second channel so colour is never the only signal.
 * `label` is for the endpoints whose own vocabulary differs from the job
 * lifecycle (an agent is enabled or disabled, a check is healthy or not).
 */
export function StatusWord({ status, label, className }: { status: string; label?: string; className?: string }) {
  return (
    <span className={`state state--${stateTone(status)}${className ? ` ${className}` : ''}`}>
      {label ?? stateWord(status)}
    </span>
  );
}