/**
 * File: CreateProductModal.tsx
 * Purpose: "New product" flow (product-design.md §3.14.6, master-first). The products
 * page has exactly one creation entry — upload images and let AI seed the master. This
 * replaces the old three-way dropdown (manual / recognize / hand off to the
 * product_launch Agent): the Agent detour just added a second selection step before
 * reaching the same upload surface. The created product lands with `onCreated`, which
 * the caller uses to navigate to the detail page's prominent "list it" CTA.
 *
 * Author: Michael Lee
 * Created: 2026-07-24
 *
 * Main exports:
 * - CreateProductModal: upload-and-recognize creation modal.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Form, Input, InputNumber, Modal, Select, Space, Typography, Upload, message } from 'antd';
import type { UploadFile } from 'antd';
import { CameraOutlined, PlusOutlined } from '@ant-design/icons';
import { productsApi } from '../../api/products';
import { useI18n } from '../../app/i18n';
import type { Product, Store } from '../../types/domain';

interface CreateProductModalProps {
  open: boolean;
  stores: Store[];
  onClose: () => void;
  onCreated: (product: Product) => void;
}

interface RecognizedDraft {
  spuCode: string;
  name: string;
  category: string;
  cost: number;
  description: string;
  totalStock: number;
  images: string[];
}

export function CreateProductModal({ open, stores, onClose, onCreated }: CreateProductModalProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [recognizing, setRecognizing] = useState(false);
  const [recognized, setRecognized] = useState<RecognizedDraft | null>(null);

  const createMutation = useMutation({
    mutationFn: productsApi.create,
    onSuccess: (product) => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      message.success(t('products.createdToast'));
      handleClose();
      onCreated(product);
    }
  });

  const handleClose = () => {
    form.resetFields();
    setFileList([]);
    setRecognized(null);
    onClose();
  };

  // 店铺列表可能在弹窗挂载后才返回，Form.Item 的 initialValue 只会取第一次渲染的值，
  // 这里在打开时补一次默认主店铺，避免下拉空白、提交时才报必填。
  useEffect(() => {
    if (open && stores.length > 0 && !form.getFieldValue('primaryStoreId')) {
      form.setFieldsValue({ primaryStoreId: stores[0].id });
    }
  }, [open, stores, form]);

  const handleRecognize = async () => {
    setRecognizing(true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    setRecognized({
      spuCode: `AI-${Date.now().toString().slice(-6)}`,
      name: t('products.recognizedNamePlaceholder'),
      category: t('products.recognizedCategoryPlaceholder'),
      cost: 10,
      description: t('products.recognizedDescPlaceholder'),
      totalStock: 100,
      images: ['https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=recognized%20product%20photo&image_size=square'],
    });
    setRecognizing(false);
  };

  const handleRecognizedSubmit = () => {
    form.validateFields(['primaryStoreId']).then(({ primaryStoreId }) => {
      if (!recognized) return;
      createMutation.mutate({ ...recognized, primaryStoreId });
    });
  };

  return (
    <Modal
      title={t('products.createRecognizeTitle')}
      open={open}
      onCancel={handleClose}
      width={560}
      footer={recognized ? undefined : null}
    >
      {!recognized ? (
        <div>
          <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>{t('products.uploadDesc')}</Typography.Paragraph>
          <Form form={form} layout="vertical">
            <Form.Item label={t('products.primaryStore')} name="primaryStoreId" rules={[{ required: true }]} initialValue={stores[0]?.id}>
              <Select options={stores.map((s) => ({ value: s.id, label: s.name }))} />
            </Form.Item>
            <Form.Item label={t('products.uploadImages')}>
              <Upload multiple listType="picture-card" fileList={fileList} onChange={({ fileList: next }) => setFileList(next)} beforeUpload={() => false} maxCount={6}>
                {fileList.length < 6 && <div><PlusOutlined /><div style={{ marginTop: 8 }}>{t('common.upload')}</div></div>}
              </Upload>
            </Form.Item>
          </Form>
          <div style={{ textAlign: 'right' }}>
            <Button onClick={handleClose}>{t('common.cancel')}</Button>
            <Button type="primary" icon={<CameraOutlined />} loading={recognizing} disabled={fileList.length === 0} onClick={handleRecognize} style={{ marginLeft: 8 }}>
              {recognizing ? t('products.recognizing') : t('products.startRecognize')}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>{t('products.previewDesc')}</Typography.Paragraph>
          <Form layout="vertical">
            <Form.Item label={t('products.name')}>
              <Input value={recognized.name} onChange={(e) => setRecognized({ ...recognized, name: e.target.value })} />
            </Form.Item>
            <Form.Item label={t('products.category')}>
              <Input value={recognized.category} onChange={(e) => setRecognized({ ...recognized, category: e.target.value })} />
            </Form.Item>
            <Form.Item label={t('products.cost')}>
              <InputNumber value={recognized.cost} style={{ width: '100%' }} prefix="¥" onChange={(v) => setRecognized({ ...recognized, cost: v ?? 0 })} />
            </Form.Item>
            <Form.Item label={t('products.totalStock')}>
              <InputNumber value={recognized.totalStock} style={{ width: '100%' }} onChange={(v) => setRecognized({ ...recognized, totalStock: v ?? 0 })} />
            </Form.Item>
            <Form.Item label={t('products.descriptionLabel')}>
              <Input.TextArea rows={3} value={recognized.description} onChange={(e) => setRecognized({ ...recognized, description: e.target.value })} />
            </Form.Item>
          </Form>
          <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button onClick={() => setRecognized(null)}>{t('common.reupload')}</Button>
            <Button type="primary" loading={createMutation.isPending} onClick={handleRecognizedSubmit}>{t('common.create')}</Button>
          </Space>
        </div>
      )}
    </Modal>
  );
}
