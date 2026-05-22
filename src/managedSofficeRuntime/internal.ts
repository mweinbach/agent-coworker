import { DEFAULT_LIBREOFFICE_VERSION, SOFFICE_HELPER_VERSION } from "./constants";
import {
  helperSource,
  helperTemplatePathCandidates,
  resetHelperSourceCacheForTest,
} from "./helperSource";
import { managedSofficeRoot, parseResolvedSofficePath, parseSofficeVersion } from "./paths";

export const __internal = {
  DEFAULT_LIBREOFFICE_VERSION,
  SOFFICE_HELPER_VERSION,
  managedSofficeRoot,
  helperSource,
  helperTemplatePathCandidates,
  resetHelperSourceCacheForTest,
  parseResolvedSofficePath,
  parseSofficeVersion,
};
