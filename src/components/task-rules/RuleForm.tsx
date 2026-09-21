'use client';

/**
 * RuleForm - Main form container for rule creation/editing
 */

import React, { useState, useEffect } from 'react';
import BasicSettingsSection from './BasicSettingsSection';
import TriggerConditionBuilder from './TriggerConditionBuilder';
import SkillSelector from './SkillSelector';
import EscalationChainSelector from './EscalationChainSelector';
import RulePreview from './RulePreview';
import ChecklistEditor from './ChecklistEditor';

type RuleFormTab = 'settings' | 'checklist';

interface RuleFormProps {
  initialRule?: any;
  onSuccess?: () => void;
}

export default function RuleForm({ initialRule, onSuccess }: RuleFormProps) {
  const [formData, setFormData] = useState({
    name: initialRule?.name || '',
    orderType: initialRule?.orderType || '',
    taskTypeId: initialRule?.taskTypeId || '',
    titleTemplate: initialRule?.titleTemplate || '',
    slaMinutes: initialRule?.slaMinutes || 30,
    priority: initialRule?.priority || 'MEDIUM',
    triggerCondition: initialRule?.triggerCondition || {
      statusIn: [],
      metadataConditions: [],
    },
    skillTagIds: initialRule?.requiredSkills?.map((s: any) => s.skillTagId) || [],
    escalationChainId: initialRule?.escalationChainId || null,
    isActive: initialRule?.isActive !== false,
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validStatuses, setValidStatuses] = useState<any[]>([]);
  const [metadataFields, setMetadataFields] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<RuleFormTab>('settings');

  useEffect(() => {
    fetchInitialData();
  }, []);

  const fetchInitialData = async () => {
    try {
      const [statusesRes, fieldsRes] = await Promise.all([
        fetch('/api/task-rules/valid-statuses'),
        fetch('/api/task-rules/metadata-fields'),
      ]);

      if (statusesRes.ok) {
        const data = await statusesRes.json();
        setValidStatuses(data.statuses);
      }

      if (fieldsRes.ok) {
        const data = await fieldsRes.json();
        setMetadataFields(data.fields);
      }
    } catch (err) {
      console.error('Failed to fetch initial data:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const method = initialRule ? 'PATCH' : 'POST';
      const url = initialRule ? `/api/task-rules/${initialRule.id}` : '/api/task-rules';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to save rule');
      }

      if (onSuccess) onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const updateField = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const updateTriggerCondition = (updates: any) => {
    setFormData(prev => ({
      ...prev,
      triggerCondition: { ...prev.triggerCondition, ...updates },
    }));
  };

  // Tab strip — keeps Settings/Trigger/Assignment together (they're saved
  // as one rule write) and isolates Checklist which writes to a different
  // endpoint and a different model (TaskType → ChecklistTemplate).
  const tabs: { id: RuleFormTab; label: string; description: string }[] = [
    { id: 'settings', label: 'Rule settings', description: 'Trigger, SLA, assignment' },
    { id: 'checklist', label: 'Checklist', description: 'Steps for each new task' },
  ];

  return (
    <div>
      {/* Tab strip */}
      <div className="flex gap-1 border-b border-gray-200 mb-6">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === t.id
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            title={t.description}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'settings' && (
        <form onSubmit={handleSubmit} className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-6">
            {error && (
              <div className="p-4 bg-red-50 border border-red-200 rounded text-red-700">
                {error}
              </div>
            )}

            <BasicSettingsSection
              formData={formData}
              updateField={updateField}
            />

            <TriggerConditionBuilder
              triggerCondition={formData.triggerCondition}
              updateTriggerCondition={updateTriggerCondition}
              validStatuses={validStatuses}
              metadataFields={metadataFields}
            />

            <div className="bg-white p-6 rounded-lg border border-gray-200">
              <h3 className="text-lg font-semibold mb-4">Assignment Settings</h3>

              <SkillSelector
                selectedSkills={formData.skillTagIds}
                onSkillsChange={(skills) => updateField('skillTagIds', skills)}
              />

              <div className="mt-6">
                <EscalationChainSelector
                  selectedChainId={formData.escalationChainId}
                  onChainChange={(chainId) => updateField('escalationChainId', chainId)}
                />
              </div>
            </div>

            <div className="flex gap-3 pt-4">
              <button
                type="submit"
                disabled={loading}
                className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
              >
                {loading ? 'Saving...' : 'Save Rule'}
              </button>
              <button
                type="button"
                onClick={() => window.history.back()}
                className="px-6 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>

          <div className="col-span-1">
            <RulePreview formData={formData} validStatuses={validStatuses} />
          </div>
        </form>
      )}

      {activeTab === 'checklist' && (
        <ChecklistEditor
          ruleId={initialRule?.id ?? null}
        />
      )}
    </div>
  );
}
