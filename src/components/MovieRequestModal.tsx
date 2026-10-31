import React, { useEffect, useState } from 'react';
import { CheckCircle2, Film, Loader2, Send, Server, X } from 'lucide-react';
import type { ServerNodeStatus, UserMovieRequest } from '../types/cinema';
import { universalApiFetch } from '../services/liveClientEngine';

interface MovieRequestModalProps {
  isOpen: boolean;
  initialTitle?: string;
  initialType?: UserMovieRequest['type'];
  activeNodeId: string;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
}

export const MovieRequestModal: React.FC<MovieRequestModalProps> = ({
  isOpen,
  initialTitle = '',
  initialType = 'MOVIE',
  activeNodeId,
  onSelectNode,
  onClose,
}) => {
  const [title, setTitle] = useState(initialTitle);
  const [type, setType] = useState<UserMovieRequest['type']>(initialType);
  const [language, setLanguage] = useState('Bangla Dubbed / Dual Audio');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submittedMsg, setSubmittedMsg] = useState(false);

  const [requests, setRequests] = useState<UserMovieRequest[]>([]);
  const [nodes, setNodes] = useState<ServerNodeStatus[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(false);

  useEffect(() => {
    setTitle(initialTitle);
    setType(initialType);
    setSubmittedMsg(false);
  }, [initialTitle, initialType, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    universalApiFetch('/api/requests')
      .then((d) => {
        if (d?.requests) setRequests(d.requests);
      })
      .catch(() => {});

    setLoadingNodes(true);
    universalApiFetch('/api/server-health')
      .then((d) => {
        if (d?.nodes) setNodes(d.nodes);
      })
      .catch(() => {})
      .finally(() => setLoadingNodes(false));
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const data = await universalApiFetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, type, language, notes }),
      });
      if (data?.ok) {
        setRequests(data.requests || []);
        setTitle('');
        setNotes('');
        setSubmittedMsg(true);
        setTimeout(() => setSubmittedMsg(false), 3000);
      }
    } catch {
      // ignore
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-end sm:items-center justify-center sm:p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#111621] border-t sm:border border-white/10 rounded-t-3xl sm:rounded-3xl w-full max-w-2xl max-h-[90dvh] overflow-y-auto p-5 sm:p-6 space-y-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-[#f47521]/15 border border-[#f47521]/40 text-[#f47521] flex items-center justify-center shrink-0">
              <Film className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-bold text-white font-display">
                মুভি রিকোয়েস্ট ও ক্লাউড সার্ভার স্পিড কন্ট্রোল
              </h3>
              <p className="text-xs text-slate-400">
                পছন্দের মুভি/অ্যানিমে রিকোয়েস্ট করুন অথবা হাই-স্পিড সার্ভার নোড পরিবর্তন করুন
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="min-h-[44px] min-w-[44px] rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 flex items-center justify-center transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 1. Live Anonymized Cloud Server Switcher */}
        <div className="rounded-2xl bg-[#0c1018] border border-white/10 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs sm:text-sm font-bold text-white">
              <Server className="w-4 h-4 text-[#1296b0]" />
              <span>হাই-স্পিড ক্লাউড সার্ভার সুইচার (Server Nodes)</span>
            </div>
            {loadingNodes && <Loader2 className="w-4 h-4 animate-spin text-[#1296b0]" />}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {(nodes.length > 0
              ? nodes
              : [
                  { id: 'node-alpha', name: 'Node Alpha', region: 'BD-Fast Edge', latencyMs: 42, online: true },
                  { id: 'node-beta', name: 'Node Beta', region: 'SG-Ultra CDN', latencyMs: 58, online: true },
                  { id: 'node-gamma', name: 'Node Gamma', region: 'Global Stream', latencyMs: 74, online: true },
                  { id: 'node-delta', name: 'Node Delta', region: 'Backup Core', latencyMs: 89, online: true },
                ]
            ).map((node) => {
              const isSelected = activeNodeId === node.id;
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onSelectNode(node.id)}
                  className={`min-h-[52px] px-3.5 py-2.5 rounded-xl border text-left flex items-center justify-between transition-colors ${
                    isSelected
                      ? 'bg-[#1296b0]/20 border-[#1296b0] text-white'
                      : 'bg-[#141b29] border-white/10 text-slate-300 hover:border-white/25'
                  }`}
                >
                  <div>
                    <div className="text-xs font-bold text-white">{node.name}</div>
                    <div className="text-[11px] text-slate-400">{node.region}</div>
                  </div>
                  <div className="text-right font-mono tabular-nums">
                    <div className={`text-xs font-bold ${node.online ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {node.online ? `${node.latencyMs} ms` : 'Standby'}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {isSelected ? 'Active Node' : 'Tap to Switch'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 2. Submit Movie Request / Report Broken Link Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div className="text-sm font-bold text-white">নতুন মুভি / সিরিজ রিকোয়েস্ট অথবা লিংক রিপোর্ট</div>

          {submittedMsg && (
            <div className="rounded-xl bg-emerald-950/60 border border-emerald-500/40 p-3 flex items-center gap-2 text-xs text-emerald-200">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>আপনার রিকোয়েস্ট সফলভাবে ক্লাউড কিউতে যুক্ত হয়েছে!</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs text-slate-400 mb-1">মুভি / অ্যানিমে / সিরিজের নাম *</label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="যেমন: Pushpa 2, Solo Leveling S02, Squid Game..."
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-[#0c1018] border border-white/10 text-xs sm:text-sm text-white placeholder-slate-500 focus:outline-none focus:border-[#f47521]"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">ক্যাটাগরি</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as UserMovieRequest['type'])}
                className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-[#0c1018] border border-white/10 text-xs sm:text-sm text-white focus:outline-none focus:border-[#f47521]"
              >
                <option value="MOVIE">Movie Request</option>
                <option value="SERIES">Web Series</option>
                <option value="ANIME">Anime</option>
                <option value="BROKEN_LINK">Broken Link Fix</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">পছন্দের অডিও ভাষা</label>
              <input
                type="text"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="Bangla Dubbed / Hindi / Dual Audio"
                className="w-full min-h-[42px] px-3.5 py-2 rounded-xl bg-[#0c1018] border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-[#f47521]"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">অতিরিক্ত তথ্য (ঐচ্ছিক)</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="1080p / 4K / Episode number..."
                className="w-full min-h-[42px] px-3.5 py-2 rounded-xl bg-[#0c1018] border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-[#f47521]"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full min-h-[46px] px-5 py-2.5 rounded-xl bg-[#f47521] hover:bg-[#ff8533] text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-colors"
          >
            <Send className="w-4 h-4" />
            <span>{submitting ? 'Submitting...' : 'Submit Request'}</span>
          </button>
        </form>

        {/* 3. Recent Community Requests Queue */}
        {requests.length > 0 && (
          <div className="space-y-2.5 border-t border-white/10 pt-4">
            <div className="text-xs font-bold text-slate-300">সাম্প্রতিক রিকোয়েস্ট কিউ ({requests.length})</div>
            <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
              {requests.map((r) => (
                <div
                  key={r.id}
                  className="p-3 rounded-xl bg-[#0c1018] border border-white/10 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-bold text-white truncate">{r.title}</div>
                    <div className="text-[11px] text-slate-400 truncate mt-0.5">
                      <span>{r.type}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{r.language}</span>
                      {r.notes ? ` · ${r.notes}` : ''}
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-emerald-400 shrink-0">{r.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
