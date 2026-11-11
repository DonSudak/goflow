'use client';

import React from 'react';

import {usePipelinePricing} from '@hooks/usePipelinePricing';
import {LightningBoltIcon} from '@radix-ui/react-icons';
import {Button} from '@radix-ui/themes';
import {useTranslation} from 'react-i18next';
import {isAIEnabled} from 'src/utils/edition';

import AILoadingAnimation from '@components/common/AILoadingAnimation';

interface ComprehensiveBibleGenerationButtonProps {
  isLoading: boolean;
  isActiveField: boolean;
  onClick: () => void;
}

const ComprehensiveBibleGenerationButtonImpl: React.FC<ComprehensiveBibleGenerationButtonProps> = ({isLoading, isActiveField, onClick}) => {
  const {t} = useTranslation();
  const {getFormattedPrice} = usePipelinePricing();
  const pipelinePrice = getFormattedPrice('bible-generation-v2');

  return (
    <Button
      size='2'
      onClick={onClick}
      disabled={isLoading}
      style={{
        opacity: isLoading && isActiveField ? 0.7 : 1,
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
      }}
    >
      {isLoading && isActiveField ? (
        <>
          <AILoadingAnimation size='small' />
          {t('dashboard.project_info.generating_bible', 'Генерирую...')}
        </>
      ) : (
        <>
          📚 {t('dashboard.project_info.generate_full_bible', 'Сгенерировать библию ')}
          {pipelinePrice && pipelinePrice !== '—' && (
            <>
              <span style={{marginLeft: '4px', display: 'inline-flex', alignItems: 'center', gap: '2px'}}>
                <LightningBoltIcon style={{width: '12px', height: '12px', color: '#ffffff'}} />
                {pipelinePrice}
              </span>
            </>
          )}
        </>
      )}
    </Button>
  );
};

/** No AI in the local edition */
export const ComprehensiveBibleGenerationButton: React.FC<ComprehensiveBibleGenerationButtonProps> = (props) => (isAIEnabled() ? <ComprehensiveBibleGenerationButtonImpl {...props} /> : null);
