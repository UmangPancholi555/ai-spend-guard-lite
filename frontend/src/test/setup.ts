import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// vitest runs without globals, so Testing Library cannot register its own afterEach cleanup
afterEach(() => cleanup());
