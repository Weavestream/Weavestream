'use client';

import { useCallback } from 'react';
import type { AssetSummary } from '../../lib/server-api';
import { assetToMarkdown } from '../../lib/asset-format';
import { useChatAssetPageContext } from './use-chat-page-context';

/**
 * Bridge that lets the server-rendered asset detail page register
 * itself with the chat panel. The asset is captured at server-render
 * time and projected to markdown on demand via the same
 * `assetToMarkdown` helper used for @-mentioned assets, so the auto-
 * attached "current asset" looks identical to a manually @-mentioned
 * one in the LLM payload.
 */
export function AssetChatContext({ asset }: { asset: AssetSummary }) {
  const getMarkdown = useCallback((): string => {
    try {
      return assetToMarkdown(asset).markdown;
    } catch {
      return '';
    }
  }, [asset]);

  useChatAssetPageContext({
    companyId: asset.companyId,
    assetId: asset.id,
    name: asset.name,
    layoutName: asset.layoutName,
    getMarkdown,
  });
  return null;
}
