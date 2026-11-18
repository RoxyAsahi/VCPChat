/**
 * VCPdesktop - vcpAPI 代理层模块
 * 负责：凭据管理、后端 API 代理 fetch、OpenAI 兼容 chat completion post、widget 脚本安全访问后端
 */

'use strict';

(function () {
    const desktopApi = window.desktopAPI || window.electronAPI;
    let _vcpCredentials = null; // 缓存凭据（admin API: Basic Auth）
    let _vcpApiCredentials = null; // 缓存凭据（VCP Chat API: Bearer Token）

    /**
     * 初始化 vcpAPI 凭据
     * @returns {Promise<boolean>} 是否初始化成功
     */
    async function initVcpApi() {
        if (!desktopApi?.desktopGetCredentials) {
            console.warn('[VCPdesktop] desktopGetCredentials not available');
            return false;
        }
        try {
            const result = await desktopApi.desktopGetCredentials();
            if (result?.success && result.apiBaseUrl) {
                _vcpCredentials = {
                    apiBaseUrl: result.apiBaseUrl,
                    auth: btoa(result.username + ':' + result.password),
                };
                console.log('[VCPdesktop] vcpAPI credentials loaded, base:', _vcpCredentials.apiBaseUrl);

                // 加载 VCP Chat API 凭据（Bearer Token 方式，用于 OpenAI 兼容接口）
                if (result.vcpServerUrl && result.vcpApiKey) {
                    _vcpApiCredentials = {
                        vcpServerUrl: result.vcpServerUrl,
                        vcpApiKey: result.vcpApiKey,
                        // 可选，来自 AppData/settings.json 的 desktopWidgetModel
                        defaultModel: typeof result.desktopWidgetModel === 'string' ? result.desktopWidgetModel : '',
                    };
                    console.log('[VCPdesktop] VCP Chat API credentials loaded');
                } else {
                    console.warn('[VCPdesktop] VCP Chat API credentials not available (vcpServerUrl or vcpApiKey missing)');
                }

                return true;
            } else {
                console.warn('[VCPdesktop] vcpAPI credentials not available');
                return false;
            }
        } catch (err) {
            console.error('[VCPdesktop] Failed to load vcpAPI credentials:', err);
            return false;
        }
    }

    /**
     * vcpAPI 代理 fetch（Admin API，Basic Auth）
     * widget 脚本中通过 vcpAPI.fetch('/admin_api/weather') 调用
     * @param {string} endpoint - API 端点路径
     * @param {object} [options] - fetch 选项
     * @returns {Promise<any>} JSON 响应
     */
    async function proxyFetch(endpoint, options = {}) {
        if (!_vcpCredentials) {
            throw new Error('vcpAPI not initialized - credentials not available');
        }
        const url = _vcpCredentials.apiBaseUrl + endpoint;
        const response = await fetch(url, {
            ...options,
            headers: {
                'Authorization': `Basic ${_vcpCredentials.auth}`,
                ...(options.headers || {}),
            },
        });
        return response.json();
    }

    /**
     * VCP API Post - 标准 OpenAI 兼容 chat completion 请求
     *
     * 这是一个安全的代理方法：widget 脚本无需知道真实的 URL 和 API Key，
     * 只需传入 messages 数组和可选的模型配置即可完成 AI 请求。
     *
     * @param {Array<{role: string, content: string}>} messages - 消息数组（OpenAI 格式）
     * @param {object} [options] - 可选配置
     * @param {string} [options.model] - 模型名称（如 'gemini-2.5-flash-preview'）
     * @param {number} [options.temperature] - 温度参数（0-2）
     * @param {number} [options.max_tokens] - 最大输出 token 数
     * @param {boolean} [options.stream=false] - 是否使用流式输出（当前仅支持非流式）
     * @returns {Promise<{success: boolean, content?: string, usage?: object, raw?: object, error?: string}>}
     *   - success: 请求是否成功
     *   - content: AI 回复的文本内容（成功时）
     *   - usage: token 使用统计（成功时，如果后端返回）
     *   - raw: 原始响应对象（成功时）
     *   - error: 错误信息（失败时）
     */
    async function vcpPost(messages, options = {}) {
        if (!_vcpApiCredentials) {
            throw new Error('VCP Chat API not initialized - vcpServerUrl or vcpApiKey not available');
        }

        const { model, temperature, max_tokens, ...extraOptions } = options;

        const requestBody = {
            messages: messages,
            stream: false, // widget 场景下默认使用非流式
        };

        // 仅在用户指定时添加可选参数
        const finalModel = model || _vcpApiCredentials.defaultModel || '';
        if (finalModel) requestBody.model = finalModel;
        if (temperature !== undefined) requestBody.temperature = temperature;
        if (max_tokens !== undefined) requestBody.max_tokens = max_tokens;

        // 合并用户自定义的额外参数
        Object.assign(requestBody, extraOptions);
        // 本函数只解析非流式响应，消息体也以第一个参数为准
        requestBody.messages = messages;
        requestBody.stream = false;

        try {
            const response = await fetch(_vcpApiCredentials.vcpServerUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${_vcpApiCredentials.vcpApiKey}`,
                },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                let errorMsg = `HTTP ${response.status}`;
                try {
                    const errorData = await response.json();
                    errorMsg = errorData.error?.message || errorData.message || errorData.error || errorMsg;
                } catch (e) {
                    const errorText = await response.text();
                    if (errorText) errorMsg += ': ' + errorText.substring(0, 200);
                }
                if (!finalModel) {
                    errorMsg += '（未指定模型：请在 options.model 传入，或在 AppData/settings.json 设置 desktopWidgetModel）';
                }
                return { success: false, error: errorMsg };
            }

            const data = await response.json();

            // 提取标准 OpenAI 格式的回复内容
            const content = data.choices?.[0]?.message?.content || '';
            const usage = data.usage || null;

            return {
                success: true,
                content: content,
                usage: usage,
                raw: data,
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * 检查凭据是否已加载
     * @returns {boolean}
     */
    function hasCredentials() {
        return _vcpCredentials !== null;
    }

    /**
     * 检查 VCP Chat API 凭据是否已加载
     * @returns {boolean}
     */
    function hasChatCredentials() {
        return _vcpApiCredentials !== null;
    }

    /**
     * 获取 API 基础 URL
     * @returns {string|null}
     */
    function getBaseUrl() {
        return _vcpCredentials?.apiBaseUrl || null;
    }

    // ------------------------------------------------------------
    // 声明式 API（modules/desktopApi）：挂件按接口 ID 调用桌面与 VChat 能力
    // ------------------------------------------------------------

    function _apiError(envelope, fallback) {
        const error = new Error(envelope?.error?.message || fallback);
        error.code = envelope?.error?.code || 'API_FAILED';
        if (envelope?.error?.field) error.field = envelope.error.field;
        return error;
    }

    function _requireApiBridge(method) {
        if (typeof desktopApi?.[method] !== 'function') {
            const error = new Error('声明式 API 不可用：当前窗口没有 desktop-api 通道');
            error.code = 'API_UNAVAILABLE';
            throw error;
        }
        return desktopApi[method];
    }

    /**
     * 列出挂件可调用的接口。
     * @param {{ prefix?: string, query?: string }} [filter] prefix 例如 'desktop.widget'；query 按关键词过滤
     * @returns {Promise<Array<{ id, title, summary, access, params }>>}
     */
    async function apiList(filter = {}) {
        const envelope = await _requireApiBridge('desktopApiList')(filter || {});
        if (!envelope?.ok) throw _apiError(envelope, '读取接口目录失败');
        return envelope.data;
    }

    /**
     * 读取单个接口的完整说明与参数 JSON Schema。
     * @param {string} apiId
     */
    async function apiDescribe(apiId) {
        const envelope = await _requireApiBridge('desktopApiDescribe')(apiId);
        if (!envelope?.ok) throw _apiError(envelope, `读取接口 ${apiId} 失败`);
        return envelope.data;
    }

    /**
     * 调用接口，成功返回数据，失败抛出带 code 的 Error
     * （API_NOT_FOUND / API_FORBIDDEN / INVALID_PARAMS / API_FAILED / API_TIMEOUT / API_UNAVAILABLE）。
     * @param {string} apiId 例如 'desktop.metrics.snapshot'
     * @param {object} [params]
     */
    async function apiCall(apiId, params = {}) {
        const envelope = await _requireApiBridge('desktopApiCall')(apiId, params || {});
        if (!envelope?.ok) throw _apiError(envelope, `调用 ${apiId} 失败`);
        return envelope.data;
    }

    // 挂载全局代理函数供 widget 脚本沙箱内调用
    window.__vcpProxyFetch = proxyFetch;
    window.__vcpProxyPost = vcpPost;
    window.__vcpApiList = apiList;
    window.__vcpApiDescribe = apiDescribe;
    window.__vcpApiCall = apiCall;

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.vcpApi = {
        init: initVcpApi,
        fetch: proxyFetch,
        post: vcpPost,
        apis: apiList,
        describe: apiDescribe,
        call: apiCall,
        hasCredentials,
        hasChatCredentials,
        getBaseUrl,
    };

})();
