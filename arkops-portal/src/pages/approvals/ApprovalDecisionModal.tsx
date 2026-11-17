/**
 * File: ApprovalDecisionModal.tsx
 * Purpose: WS-B (B4) shared confirm step for approval decisions. Both the
 * approval detail page and the Action Inbox quick actions route approve/reject
 * through this modal so no decision can be committed with a single click.
 * Shows the consequence of the decision, the real change summary, dual-approval
 * context, and captures an optional note that is written to the audit log.
 *
 * Author: Michael Lee
 * Created: 2026-07-22
 *
 * Main exports:
 * - ApprovalDecisionModal: confirm dialog with consequence copy + optional note.
 *
 * Major updates:
 * - 2026-07-22: WS-B — created for B4 decision safeguards.
 */
import { ArrowRightOutlined } from '@ant-design/icons';
import { Alert, Checkbox, Input, Modal, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useI18n } from '../../app/i18n';
import { resolveApprovalRequirement } from '../../api/operatingModel';
import { computeEvidenceDelta } from '../inbox/urgency';
import type { Approval } from '../../types/domain';

export type ApprovalDecision = 'approved' | 'rejected';

interface ApprovalDecisionModalProps {
  approval: Approval | null;
  decision: ApprovalDecision | null;
  submitting?: boolean;
  onCancel: () => void;
  /** P57：approve 时带上「是否显式豁免护栏」，由审批接口再兜底复核一次。 */
  onConfirm: (note: string, acknowledgeGuardViolation: boolean) => void;
}

/**
 * Confirm dialog for approve/reject decisions with consequence explanation,
 * real evidence summary, and an optional decision note.
 */
export function ApprovalDecisionModal({ approval, decision, submitting, onCancel, onConfirm }: ApprovalDecisionModalProps) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  // P57：越界时默认不勾选，通过按钮不可用——人必须真的看过护栏结论才能放行。
  const [guardAcknowledged, setGuardAcknowledged] = useState(false);
  const open = !!approval && !!decision;

  useEffect(() => {
    if (open) {
      setNote('');
      setGuardAcknowledged(false);
    }
  }, [open, approval?.id, decision]);

  if (!approval || !decision) {
    return null;
  }

  const isApprove = decision === 'approved';
  const requirement =
    approval.requirement ?? resolveApprovalRequirement(approval.storeId, approval.agentType, approval.riskLevel);
  const isDual = requirement === 'dual';
  const completedApprovals = approval.priorApprovals?.length ?? 0;
  const isFirstOfDual = isApprove && isDual && completedApprovals + 1 < 2;
  const guardViolations = isApprove ? approval.guardViolations ?? [] : [];
  const guardBlocked = guardViolations.length > 0;

  const consequence = isApprove
    ? isDual
      ? t('approvalDetail.dualApproveConsequence', { step: completedApprovals + 1 })
      : t('approvalDetail.approveConsequence')
    : t('approvalDetail.rejectConsequence');

  return (
    <Modal
      open={open}
      title={isApprove ? t('approvalDetail.confirmApproveTitle') : t('approvalDetail.confirmRejectTitle')}
      okText={
        isFirstOfDual
          ? t('approvalDetail.confirmFirstApprove')
          : isApprove
            ? t('approvalDetail.confirmApprove')
            : t('approvalDetail.confirmReject')
      }
      cancelText={t('common.cancel')}
      okButtonProps={{
        danger: !isApprove,
        loading: submitting,
        disabled: guardBlocked && !guardAcknowledged,
      }}
      onOk={() => onConfirm(note.trim(), guardAcknowledged)}
      onCancel={onCancel}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {guardBlocked ? (
          <Alert
            type="error"
            showIcon
            message={t('approvalDetail.guardReviewTitle')}
            description={
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {guardViolations.map((violation) => (
                  <Typography.Text key={violation.kind} style={{ fontSize: 12 }}>
                    {t(`approvalDetail.guardViolation_${violation.kind}`, {
                      actual: String(violation.actual),
                      limit: String(violation.limit),
                    })}
                  </Typography.Text>
                ))}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('approvalDetail.guardReviewHint')}
                </Typography.Text>
              </Space>
            }
          />
        ) : (
          <Alert type={isApprove ? 'info' : 'warning'} showIcon message={consequence} />
        )}
        <div>
          <Typography.Text strong>{approval.title}</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 4, fontSize: 12 }}>
            {approval.storeName} · {t(`agent.${approval.agentType}`)}
          </Typography.Paragraph>
          {approval.evidence?.length ? (
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              {approval.evidence.map((field) => {
                const delta = computeEvidenceDelta(field);
                return (
                  <Typography.Text key={field.label} style={{ fontSize: 12 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{field.label}：</Typography.Text>
                    {field.before} <ArrowRightOutlined style={{ fontSize: 10, color: 'var(--ark-muted)' }} /> {field.after}
                    {delta && (
                      <Tag
                        style={{ marginLeft: 6, fontSize: 10 }}
                        color={delta.direction === 'up' ? 'blue' : 'orange'}
                      >
                        {delta.text}
                      </Tag>
                    )}
                  </Typography.Text>
                );
              })}
            </Space>
          ) : (
            <Typography.Text style={{ fontSize: 12 }}>
              {approval.beforeValue} <ArrowRightOutlined style={{ fontSize: 10, color: 'var(--ark-muted)' }} /> {approval.afterValue}
            </Typography.Text>
          )}
        </div>
        {guardBlocked && (
          <Checkbox checked={guardAcknowledged} onChange={(event) => setGuardAcknowledged(event.target.checked)}>
            {t('approvalDetail.guardReviewAck')}
          </Checkbox>
        )}
        <div>
          <Typography.Text strong style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
            {t('approvalDetail.noteLabel')}
          </Typography.Text>
          <Input.TextArea
            rows={2}
            maxLength={200}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('approvalDetail.notePlaceholder')}
          />
        </div>
      </Space>
    </Modal>
  );
}
