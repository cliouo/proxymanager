import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import * as z from 'zod';

extendZodWithOpenApi(z);

export { z };
