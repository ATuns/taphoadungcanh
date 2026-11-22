import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || 'Đã xảy ra lỗi không xác định.',
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Uncaught application error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let parsedDetails: Record<string, unknown> | null = null;
      try {
        parsedDetails = JSON.parse(this.state.errorMessage);
      } catch {
        parsedDetails = null;
      }

      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-white border border-slate-200 rounded-xl p-6">
            <div className="flex items-center gap-3 text-red-600 mb-3">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h2 className="text-lg font-bold text-slate-900">
                Cảnh báo kết nối hoặc phân quyền dữ liệu
              </h2>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Hệ thống gặp sự cố khi truy xuất cơ sở dữ liệu. Vui lòng kiểm tra trạng thái đăng nhập hoặc tải lại trang.
            </p>
            {parsedDetails ? (
              <div className="bg-slate-100 rounded-lg p-3 text-xs font-mono text-slate-700 mb-4 overflow-x-auto">
                <div>Thao tác: {String(parsedDetails.operationType || '')}</div>
                <div>Đường dẫn: {String(parsedDetails.path || '')}</div>
                <div>Chi tiết: {String(parsedDetails.error || '')}</div>
              </div>
            ) : (
              <div className="bg-slate-100 rounded-lg p-3 text-xs font-mono text-slate-700 mb-4">
                {this.state.errorMessage}
              </div>
            )}
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-sm font-medium rounded-lg hover:bg-slate-800 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Tải lại ứng dụng
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
