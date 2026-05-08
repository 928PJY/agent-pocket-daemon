// Agent Pocket — Static Claude model catalog
// Hard-coded list of supported model families/versions surfaced to the
// phone alongside `get_supported_models`. The SDK reports the dynamic list
// but the phone uses this catalog to render iconography + group families.
//
// Update this when adding a new model release.

export const STATIC_MODEL_CATALOG = {
  entries: [
    { family: 'sonnet', version: '4-5', version_label: '4.5', supports_one_m: true,  effort_levels: [] as Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'> },
    { family: 'sonnet', version: '4-6', version_label: '4.6', supports_one_m: true,  effort_levels: [] },
    { family: 'opus',   version: '4-5', version_label: '4.5', supports_one_m: false, effort_levels: [] },
    { family: 'opus',   version: '4-6', version_label: '4.6', supports_one_m: true,  effort_levels: [] },
    { family: 'opus',   version: '4-7', version_label: '4.7', supports_one_m: true,  effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { family: 'haiku',  version: '4-5', version_label: '4.5', supports_one_m: false, effort_levels: [] },
  ],
} as const;
