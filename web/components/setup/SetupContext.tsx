'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { runSetupBootstrap } from '@/lib/client/setup';
import { api } from '@/lib/client/api';
import type { Profile } from '@/components/profile/ProfileContext';
import type {
  SetupApiStatus,
  SetupBootstrapApiResponse,
  SetupBootstrapRequest,
} from '@/schemas/setup';

interface SetupContextValue {
  status: SetupApiStatus | null;
  initialProfiles: Profile[] | null;
  loading: boolean;
  error: string | null;
  initializing: boolean;
  refresh: () => Promise<SetupApiStatus | null>;
  bootstrap: (request: SetupBootstrapRequest) => Promise<SetupBootstrapApiResponse>;
}

const SetupContext = createContext<SetupContextValue | null>(null);

export function SetupProvider({ children }: { children: React.ReactNode }) {
  const [initialProfiles, setInitialProfiles] = useState<Profile[] | null>(null);
  const [status, setStatus] = useState<SetupApiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);
  const requestId = useRef(0);

  const refresh = useCallback(async (): Promise<SetupApiStatus | null> => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api<{ data: { status: SetupApiStatus; profiles: Profile[] } }>(
        '/api/v1/bootstrap',
      );
      const next = data.status;
      if (id === requestId.current) {
        setStatus(next);
        setInitialProfiles(data.profiles);
      }
      return next;
    } catch (caught) {
      if (id === requestId.current) {
        setError(caught instanceof Error ? caught.message : '无法读取实例状态');
      }
      return null;
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const bootstrap = useCallback(
    async (request: SetupBootstrapRequest): Promise<SetupBootstrapApiResponse> => {
      setInitializing(true);
      try {
        const result = await runSetupBootstrap(request);
        setError(null);
        return result;
      } finally {
        setInitializing(false);
      }
    },
    [],
  );

  const value = useMemo<SetupContextValue>(
    () => ({ status, initialProfiles, loading, error, initializing, refresh, bootstrap }),
    [status, initialProfiles, loading, error, initializing, refresh, bootstrap],
  );

  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>;
}

export function useSetup(): SetupContextValue {
  const value = useContext(SetupContext);
  if (!value) throw new Error('useSetup must be used within SetupProvider');
  return value;
}
