import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { ProblemDetailsError } from '@/lib/http/problem';

/** Only label data with a version that brackets its complete read. */
export async function versionedRead<T>(
  read: () => Promise<T>,
): Promise<{ data: T; configVersion: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const configVersion = await getConfigVersion();
    const data = await read();
    if (configVersion === (await getConfigVersion())) return { data, configVersion };
  }
  throw ProblemDetailsError.preconditionFailed('配置正在变化，请重新读取后重试。');
}
