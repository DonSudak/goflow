import React, {useState} from 'react';

import {usePipelinePricing} from '@hooks/usePipelinePricing';
import {useTeamAIAccess} from '@hooks/useTeamAIAccess';
import {CheckIcon, Cross1Icon, GearIcon, LightningBoltIcon, MagicWandIcon} from '@radix-ui/react-icons';
import {Button, Flex, Tooltip} from '@radix-ui/themes';
import {useTranslation} from 'react-i18next';
import {isAIEnabled} from 'src/utils/edition';

import {NoAIAccessModal} from '@components/common/NoAIAccessModal';

interface AIFieldButtonProps {
  fieldType: string;
  isLoading: boolean;
  isPending: boolean;
  onGenerate: (usePipeline?: boolean) => void;
  onAccept: () => void;
  onReject: () => void;
  onOpenPipelineModal?: () => void;
  disabled?: boolean;
  showPipelineOption?: boolean;
  showPipelineModal?: boolean;
}

const AIFieldButtonImpl: React.FC<AIFieldButtonProps> = ({
  fieldType,
  isLoading,
  isPending,
  onGenerate,
  onAccept,
  onReject,
  onOpenPipelineModal,
  disabled = false,
  showPipelineOption = true,
  showPipelineModal = false
}) => {
  const {t} = useTranslation();
  const {getFormattedPrice} = usePipelinePricing();
  const pipelinePrice = getFormattedPrice('single-field-bible-v2');

  // Проверка доступа к ИИ
  const {hasAIAccess, isTeamPlan} = useTeamAIAccess();
  const [showNoAccessModal, setShowNoAccessModal] = useState(false);

  const handleGenerateClick = (usePipeline?: boolean) => {
    // Проверяем доступ к ИИ для Team планов
    if (isTeamPlan && !hasAIAccess) {
      setShowNoAccessModal(true);
      return;
    }

    onGenerate(usePipeline);
  };

  // Проверяем, должны ли кнопки быть отключены из-за отсутствия доступа к ИИ
  const isDisabledDueToAIAccess = isTeamPlan && !hasAIAccess;
  const buttonDisabled = disabled || isLoading || isDisabledDueToAIAccess;

  // If content is in pending state, show accept/reject buttons
  if (isPending) {
    return (
      <>
        <Flex gap='1'>
          <Tooltip content={t('project_bible.ai_button.accept')}>
            <Button size='2' variant='soft' color='green' onClick={onAccept} disabled={disabled}>
              <CheckIcon />
            </Button>
          </Tooltip>
          <Tooltip content={t('project_bible.ai_button.reject')}>
            <Button size='2' variant='soft' color='tomato' onClick={onReject} disabled={disabled}>
              <Cross1Icon />
            </Button>
          </Tooltip>
        </Flex>
        <NoAIAccessModal isOpen={showNoAccessModal} onClose={() => setShowNoAccessModal(false)} />
      </>
    );
  }

  // If showing pipeline modal, show only Quick, Pipeline Modal and classic buttons
  if (showPipelineModal && onOpenPipelineModal) {
    return (
      <>
        <Flex gap='1'>
          {showPipelineOption && (
            <Tooltip content={isDisabledDueToAIAccess ? t('ai_access.no_access_tooltip', 'Нет доступа к ИИ. Обратитесь к администратору команды.') : t('project_bible.ai_button.quick_pipeline')}>
              <Button size='2' variant='soft' color='violet' onClick={() => handleGenerateClick(true)} disabled={buttonDisabled} loading={isLoading}>
                ⚡ Fast fill{' '}
                {pipelinePrice && pipelinePrice !== '—' && (
                  <>
                    <span style={{marginLeft: '4px', display: 'inline-flex', alignItems: 'center', gap: '2px'}}>
                      <LightningBoltIcon style={{width: '12px', height: '12px', color: '#8b5cf6'}} />
                      {pipelinePrice}
                    </span>
                  </>
                )}
              </Button>
            </Tooltip>
          )}
          <Tooltip content={isDisabledDueToAIAccess ? t('ai_access.no_access_tooltip', 'Нет доступа к ИИ. Обратитесь к администратору команды.') : t('project_bible.ai_button.pipeline_with_settings')}>
            <Button
              size='2'
              variant='soft'
              color='violet'
              onClick={() => {
                if (isDisabledDueToAIAccess) {
                  setShowNoAccessModal(true);
                  return;
                }
                onOpenPipelineModal && onOpenPipelineModal();
              }}
              disabled={buttonDisabled}
              loading={isLoading}
            >
              💬 Fill with idea
            </Button>
          </Tooltip>
        </Flex>
        <NoAIAccessModal isOpen={showNoAccessModal} onClose={() => setShowNoAccessModal(false)} />
      </>
    );
  }

  // Regular generation button only via pipeline
  if (showPipelineOption) {
    return (
      <>
        <Flex gap='1'>
          <Tooltip
            content={isDisabledDueToAIAccess ? t('ai_access.no_access_tooltip', 'Нет доступа к ИИ. Обратитесь к администратору команды.') : t('project_bible.ai_button.generate_pipeline_emoji')}
          >
            <Button size='1' variant='solid' onClick={() => handleGenerateClick(true)} disabled={buttonDisabled} loading={isLoading}>
              🚀 Pipeline{' '}
              {pipelinePrice && pipelinePrice !== '—' && (
                <>
                  <span style={{marginLeft: '4px', display: 'inline-flex', alignItems: 'center', gap: '2px'}}>
                    <LightningBoltIcon style={{width: '12px', height: '12px', color: '#ffffff'}} />
                    {pipelinePrice}
                  </span>
                </>
              )}
            </Button>
          </Tooltip>
        </Flex>
        <NoAIAccessModal isOpen={showNoAccessModal} onClose={() => setShowNoAccessModal(false)} />
      </>
    );
  }

  // Regular button only via pipeline (for compatibility)
  return (
    <>
      <Tooltip content={isDisabledDueToAIAccess ? t('ai_access.no_access_tooltip', 'Нет доступа к ИИ. Обратитесь к администратору команды.') : t('project_bible.ai_button.generate_pipeline')}>
        <Button size='1' variant='solid' onClick={() => handleGenerateClick(true)} disabled={buttonDisabled} loading={isLoading}>
          🚀 Pipeline{' '}
          {pipelinePrice && pipelinePrice !== '—' && (
            <>
              <span style={{marginLeft: '4px', display: 'inline-flex', alignItems: 'center', gap: '2px'}}>
                <LightningBoltIcon style={{width: '12px', height: '12px', color: '#ffffff'}} />
                {pipelinePrice}
              </span>
            </>
          )}
        </Button>
      </Tooltip>
      <NoAIAccessModal isOpen={showNoAccessModal} onClose={() => setShowNoAccessModal(false)} />
    </>
  );
};

/** No AI in the local edition */
const AIFieldButton: React.FC<AIFieldButtonProps> = (props) => (isAIEnabled() ? <AIFieldButtonImpl {...props} /> : null);

export default AIFieldButton;
