'use client';

import { useEffect, useState } from 'react';
import { cls } from '@/lib/client/ui';

/**
 * components/settings/JsonEditor.tsx —— 简易 JSON 对象编辑器
 *
 * 用于「额外请求头」等键值配置：输入即校验，语法错误时不向上抛出变更，
 * 避免把坏数据带进保存流程。切换编辑对象时请在父组件传入 key 以重置内部状态。
 */

interface Props<T extends Record<string, unknown>> {
  value: T;
  onChange: (v: T) => void;
  placeholder?: string;
  rows?: number;
  /** 校验通过时的提示（例如「3 个请求头」） */
  hint?: string;
}

export default function JsonEditor<T extends Record<string, unknown>>({
  value,
  onChange,
  placeholder = '{ "X-Header": "value" }',
  rows = 4,
  hint,
}: Props<T>) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  /* 外部值变化（如切换配置）且本地未被编辑时，同步文本 */
  useEffect(() => {
    if (!dirty) setText(JSON.stringify(value ?? {}, null, 2));
  }, [value, dirty]);

  function handleChange(next: string) {
    setText(next);
    setDirty(true);

    if (next.trim() === '') {
      setError(null);
      onChange({} as T);
      return;
    }
    try {
      const parsed = JSON.parse(next) as T;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('需为 JSON 对象（形如 { "Key": "Value" }）');
        return;
      }
      setError(null);
      onChange(parsed);
    } catch {
      setError('JSON 语法错误');
    }
  }

  function format() {
    try {
      const parsed = JSON.parse(text) as T;
      const pretty = JSON.stringify(parsed, null, 2);
      setText(pretty);
      setError(null);
      setDirty(false);
      onChange(parsed);
    } catch {
      setError('JSON 语法错误，无法格式化');
    }
  }

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        className={cls(
          'field font-mono text-xs leading-relaxed',
          error && 'border-neon-red/60 focus:border-neon-red',
        )}
      />
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
        <span className={error ? 'text-neon-red' : 'text-fog/70'}>
          {error ? `✗ ${error}` : `✓ ${hint ?? `${Object.keys(value ?? {}).length} 项，JSON 合法`}`}
        </span>
        <button
          type="button"
          onClick={format}
          className="text-fog underline hover:text-neon-blue"
        >
          格式化
        </button>
      </div>
    </div>
  );
}