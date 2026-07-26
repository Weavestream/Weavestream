import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { createQueryClient } from './lib/query-client';
import { router } from './router';

export function App() {
  // Created once per mount rather than at module scope so a test can
  // render the app with a fresh cache.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
