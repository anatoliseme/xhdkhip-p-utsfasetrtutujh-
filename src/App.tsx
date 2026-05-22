import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Send, Plus, Check, Video, StopCircle, Volume2, VolumeX } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import { collection, query, orderBy, onSnapshot, setDoc, doc, serverTimestamp, getDoc } from 'firebase/firestore';
import { getGenerativeModel, Part } from 'firebase/ai';
import { auth, db, ai, handleFirestoreError, OperationType } from './lib/firebase';

// --- Types & Data ---

type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  videoBase64?: string;
  videoMimeType?: string;
  createdAt?: number;
};

const VideoCircleMessage = ({ src, standalone }: { src: string, standalone?: boolean }) => {
  const [isMuted, setIsMuted] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  const toggleMute = () => {
    setIsMuted(!isMuted);
    if (videoRef.current) {
      if (isMuted) {
        videoRef.current.currentTime = 0;
      }
      videoRef.current.muted = !isMuted;
    }
  };

  return (
    <div className={`relative group cursor-pointer shrink-0 w-48 h-48 md:w-56 md:h-56 ${standalone ? '' : 'mb-3 sm:self-end'}`} onClick={toggleMute}>
      <video
        ref={videoRef}
        src={src}
        autoPlay
        loop
        muted
        playsInline
        className="w-full h-full rounded-full object-cover shadow-xl border-4 border-white/10 transition-transform duration-300 group-active:scale-95"
      />
      <div className={`absolute inset-0 flex items-center justify-center transition-opacity bg-black/20 rounded-full pointer-events-none ${isMuted ? 'opacity-100 md:opacity-0 md:group-hover:opacity-100' : 'opacity-0'}`}>
        {isMuted && <VolumeX className="w-10 h-10 text-white drop-shadow-md" />}
      </div>
    </div>
  );
};

const MODELS = [
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', desc: 'Самая умная модель на данный момент' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', desc: 'Быстрые ответы на базовые задачи' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', desc: 'Самые быстрые ответы' },
  { id: 'gemma-4', name: 'Gemma 4', desc: 'Новая открытая модель' },
];

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState(MODELS[0]);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Video Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [recordingStream, setRecordingStream] = useState<MediaStream | null>(null);

  // Authentication
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        // Ensure user profile exists
        try {
          const userRef = doc(db, 'users', currentUser.uid);
          const userSnap = await getDoc(userRef);
          if (!userSnap.exists()) {
            await setDoc(userRef, {
              createdAt: serverTimestamp()
            });
          }
        } catch (error) {
          console.error("Error creating user profile", error);
        }
      }
      setUser(currentUser);
      setAuthReady(true);
    });
    return unsubscribe;
  }, []);

  // Fetch messages from Firestore
  useEffect(() => {
    if (!user) {
      setMessages([]);
      return;
    }
    const q = query(
      collection(db, 'users', user.uid, 'messages'),
      orderBy('createdAt', 'asc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs: Message[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        msgs.push({
          id: docSnap.id,
          role: data.role as 'user' | 'assistant',
          text: data.text,
          videoBase64: data.videoBase64,
          videoMimeType: data.videoMimeType,
          createdAt: data.createdAt?.toMillis() || Date.now()
        });
      });
      setMessages(msgs);
    }, (error) => handleFirestoreError(error, OperationType.GET, `users/${user.uid}/messages`));
    
    return unsubscribe;
  }, [user]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleLogout = async () => {
    try {
      await auth.signOut();
    } catch (error) {
      console.error("Logout failed", error);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !user) return;
    
    const textToSend = input.trim();
    setInput('');

    // Prepare chat history to send to server
    const chatHistory = [...messages, { role: 'user', text: textToSend }];

    // Write user message to Firestore
    try {
      const userMsgRef = doc(collection(db, 'users', user.uid, 'messages'));
      await setDoc(userMsgRef, {
        text: textToSend,
        role: 'user',
        userId: user.uid,
        createdAt: serverTimestamp()
      });

      // Call Firebase AI Logic directly
      try {
        const model = getGenerativeModel(ai, { model: selectedModel.id });
        
        // Convert chat history to AI Logic contents structure
        const contents = chatHistory.map(msg => {
          let parts: Part[] = [{ text: msg.text }];
          if ('videoBase64' in msg && msg.videoBase64) {
             parts.push({ inlineData: { data: msg.videoBase64 as string, mimeType: (msg.videoMimeType as string) || 'video/webm' }});
          }
          return {
            role: (msg.role === 'assistant' ? 'model' : 'user') as 'model' | 'user',
            parts
          };
        });

        const result = await model.generateContent({ contents });
        const text = result.response.text();

        if (text) {
          const botMsgRef = doc(collection(db, 'users', user.uid, 'messages'));
          await setDoc(botMsgRef, {
            text: text,
            role: 'assistant',
            userId: user.uid,
            createdAt: serverTimestamp()
          });
        }
      } catch (error) {
        console.error("Gemini API Error:", error);
        // Provide visual fallback
        const botMsgRef = doc(collection(db, 'users', user.uid, 'messages'));
        await setDoc(botMsgRef, {
          text: 'Извините, произошла ошибка подключения к ИИ.',
          role: 'assistant',
          userId: user.uid,
          createdAt: serverTimestamp()
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}/messages`);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 240, height: 240 }, audio: true });
      setRecordingStream(stream);
      setIsRecording(true);
      
      let mimeType = '';
      if (MediaRecorder.isTypeSupported('video/webm')) {
          mimeType = 'video/webm';
      } else if (MediaRecorder.isTypeSupported('video/mp4')) {
          mimeType = 'video/mp4';
      }

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 100000 } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => {
          const base64Url = reader.result as string; 
          sendVideoMessage(base64Url);
        };
        stream.getTracks().forEach(track => track.stop());
        setRecordingStream(null);
        setIsRecording(false);
      };
      
      recorder.start();
      setMediaRecorder(recorder);

      // Connect stream to preview video element by waiting a tick for React to render it
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
      }, 50);

    } catch (err) {
      console.error("Camera access denied or error:", err);
      alert("Не удалось получить доступ к камере или микрофону. Проверьте разрешения в браузере.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorder && isRecording) {
      mediaRecorder.stop();
    }
  };

  const sendVideoMessage = async (base64Url: string) => {
    if (!user) return;
    const base64Data = base64Url.split(',')[1];
    const mimeType = base64Url.match(/data:(.*?);/)?.[1] || 'video/webm';
    
    try {
      const userMsgRef = doc(collection(db, 'users', user.uid, 'messages'));
      await setDoc(userMsgRef, {
        text: 'Кружок',
        role: 'user',
        userId: user.uid,
        videoBase64: base64Data,
        videoMimeType: mimeType,
        createdAt: serverTimestamp()
      });

      try {
        const model = getGenerativeModel(ai, { model: selectedModel.id });
        
        const contents = messages.map(msg => {
          let parts: Part[] = [{ text: msg.text }];
          if ('videoBase64' in msg && msg.videoBase64) {
             parts.push({ inlineData: { data: msg.videoBase64 as string, mimeType: (msg.videoMimeType as string) || 'video/webm' }});
          }
          return {
            role: (msg.role === 'assistant' ? 'model' : 'user') as 'model' | 'user',
            parts
          };
        });
        
        contents.push({
          role: 'user',
          parts: [
            { text: 'Я записал(а) видео-сообщение (кружок). Посмотри его и ответь.' },
            { inlineData: { data: base64Data, mimeType: mimeType } }
          ]
        });

        const result = await model.generateContent({ contents });
        const text = result.response.text();

        if (text) {
          const botMsgRef = doc(collection(db, 'users', user.uid, 'messages'));
          await setDoc(botMsgRef, {
            text: text,
            role: 'assistant',
            userId: user.uid,
            createdAt: serverTimestamp()
          });
        }
      } catch (error) {
        console.error("Gemini API Error with Video:", error);
        const botMsgRef = doc(collection(db, 'users', user.uid, 'messages'));
        await setDoc(botMsgRef, {
          text: 'Извините, не удалось обработать видео-сообщение.',
          role: 'assistant',
          userId: user.uid,
          createdAt: serverTimestamp()
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}/messages`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!authReady) {
    return <div className="flex h-dvh items-center justify-center bg-[#111111] text-white">Загрузка...</div>;
  }

  if (!user) {
    return (
      <div className="flex flex-col h-dvh w-full bg-[#111111] text-white items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 blur-[80px] opacity-30 mix-blend-screen pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full bg-pink-600/40"></div>
        </div>
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative z-10 flex flex-col items-center gap-6"
        >
          <h1 className="text-4xl font-medium tracking-tight">Аника</h1>
          <p className="text-white/60 mb-4">Войдите, чтобы продолжить общение</p>
          <button 
            onClick={handleLogin}
            className="px-6 py-3 bg-white text-black font-medium rounded-full hover:bg-white/90 transition-colors"
          >
            Войти через Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-dvh w-full bg-[#111111] text-white relative font-sans overflow-hidden">
      
      {/* Background Animated Aurora Gradient */}
      <div className="absolute bottom-0 left-0 right-0 h-[60vh] pointer-events-none opacity-80 z-0 overflow-hidden">
        <div className="absolute inset-0 blur-[60px] opacity-70 mix-blend-screen">
           <motion.div
              animate={{
                scale: [1, 1.2, 1],
                x: [0, 40, -20, 0],
                y: [0, -30, 10, 0],
              }}
              transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
              className="absolute -bottom-10 left-[10%] w-[40%] h-[80%] rounded-full bg-pink-600/40"
           />
           <motion.div
              animate={{
                scale: [1, 1.1, 0.9, 1],
                x: [0, -30, 20, 0],
                y: [0, 20, -10, 0],
              }}
              transition={{ duration: 15, repeat: Infinity, ease: "easeInOut" }}
              className="absolute -bottom-10 right-[10%] w-[40%] h-[80%] rounded-full bg-pink-600/40"
           />
           <motion.div
              animate={{
                scale: [1, 1.3, 1],
                x: [0, 20, -40, 0],
                y: [0, -20, 20, 0],
              }}
              transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
              className="absolute -bottom-10 left-[30%] w-[40%] h-[60%] rounded-full bg-yellow-500/30"
           />
           <motion.div
              animate={{
                scale: [1, 1.2, 1],
                x: [0, 50, -20, 0],
              }}
              transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
              className="absolute -bottom-20 left-[-10%] w-[50%] h-[60%] rounded-full bg-lime-500/30"
           />
           <motion.div
              animate={{
                scale: [1, 1.1, 1],
                x: [0, -50, 20, 0],
              }}
              transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
              className="absolute -bottom-20 right-[-10%] w-[50%] h-[60%] rounded-full bg-lime-500/30"
           />
        </div>
      </div>

      {/* Top Navigation */}
      <header className="relative z-20 flex items-center justify-between p-4 pt-6 px-6">
        <div className="relative">
          <button 
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="flex items-center gap-2 text-xl font-medium tracking-tight hover:opacity-80 transition-opacity"
          >
            {selectedModel.name}
            <ChevronDown className={`w-5 h-5 transition-transform duration-200 ${isDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {/* Model Selector Dropdown */}
          <AnimatePresence>
            {isDropdownOpen && (
              <motion.div 
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.95 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                className="absolute top-10 left-0 mt-2 w-[340px] bg-[#2a2a2a]/95 backdrop-blur-xl rounded-2xl p-2 shadow-2xl border border-white/5 z-50"
              >
                {MODELS.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => {
                      setSelectedModel(model);
                      setIsDropdownOpen(false);
                    }}
                    className={`w-full text-left px-4 py-3 rounded-xl flex items-center justify-between group transition-colors ${
                      selectedModel.id === model.id ? 'bg-white/5' : 'hover:bg-white/5'
                    }`}
                  >
                    <div>
                      <div className="font-semibold text-[15px] text-white">{model.name}</div>
                      <div className="text-xs text-white/50 mt-0.5">{model.desc}</div>
                    </div>
                    {selectedModel.id === model.id && (
                      <Check className="w-5 h-5 text-white" />
                    )}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Custom Profile Icon - Logout */}
        <button 
          title="Выйти"
          onClick={handleLogout}
          className="w-10 h-10 flex items-center justify-center hover:opacity-80 transition-opacity"
        >
          <a href="https://ibb.co/qFV30Vr2" onClick={(e) => e.preventDefault()} className="w-full h-full flex items-center justify-center">
            <img src="https://i.ibb.co/1Jjtsjm4/fybrfffffffffffffffff.png" alt="Profile" className="w-full h-full object-contain opacity-90 drop-shadow-md" />
          </a>
        </button>
      </header>

      {/* Main Chat Area */}
      <main className="flex-1 overflow-y-auto relative z-10 flex flex-col pt-8 pb-32 px-4 md:px-8 max-w-4xl mx-auto w-full scrollbar-none" style={{ scrollbarWidth: 'none' }}>
        
        {messages.length === 0 ? (
          // Empty State Greeting
          <div className="flex-1 flex flex-col items-center justify-center text-center -mt-20">
            <motion.h1 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="text-4xl md:text-5xl font-medium tracking-tight mb-3"
            >
              привет, я аника!
            </motion.h1>
            <motion.p 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
              className="text-xl md:text-2xl text-white/80"
            >
              чем могу помочь?
            </motion.p>
          </div>
        ) : (
          // Message List
          <div className="flex flex-col gap-8 pb-4">
            {messages.map((msg) => (
              <motion.div 
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.role === 'user' ? (
                  msg.videoBase64 && msg.text === 'Кружок' ? (
                    <VideoCircleMessage standalone src={`data:${msg.videoMimeType || 'video/webm'};base64,${msg.videoBase64}`} />
                  ) : (
                    <div className="bg-white/15 backdrop-blur-md px-5 py-3 rounded-[24px] rounded-br-sm max-w-[85%] border border-white/10 shadow-sm flex flex-col pt-4">
                      {msg.videoBase64 && (
                        <VideoCircleMessage src={`data:${msg.videoMimeType || 'video/webm'};base64,${msg.videoBase64}`} />
                      )}
                      <p className="text-[17px] leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                    </div>
                  )
                ) : (
                  <div className="px-1 py-1 max-w-[90%]">
                    <p className="text-[17px] leading-relaxed whitespace-pre-wrap font-medium">{msg.text}</p>
                  </div>
                )}
              </motion.div>
            ))}
            <div ref={messagesEndRef} className="h-4" />
          </div>
        )}
      </main>

      {/* Input Area */}
      <div className="absolute bottom-6 left-0 right-0 px-4 md:px-8 z-20 flex justify-center">
        <div className="w-full max-w-4xl relative">
          
          <AnimatePresence>
            {isRecording && (
               <motion.div 
                 initial={{ opacity: 0, scale: 0.8, y: 20 }}
                 animate={{ opacity: 1, scale: 1, y: 0 }}
                 exit={{ opacity: 0, scale: 0.8, y: 20 }}
                 className="absolute bottom-20 right-4 md:right-10 z-50 flex flex-col items-center gap-4"
               >
                 <div className="relative w-56 h-56 rounded-full overflow-hidden border-4 border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.3)] bg-black">
                   <video 
                     ref={videoRef} 
                     muted 
                     srcObject={recordingStream || undefined} 
                     className="w-full h-full object-cover transform scale-x-[-1]" 
                   />
                   <div className="absolute top-4 inset-x-0 flex justify-center">
                     <div className="bg-red-500/80 backdrop-blur-sm text-white px-3 py-1 rounded-full text-sm font-medium animate-pulse flex items-center gap-2">
                       <div className="w-2 h-2 rounded-full bg-white"></div>
                       Запись
                     </div>
                   </div>
                 </div>
                 <button 
                   onClick={stopRecording}
                   className="w-14 h-14 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center text-white shadow-xl transition-colors"
                 >
                   <StopCircle className="w-8 h-8" />
                 </button>
               </motion.div>
            )}
          </AnimatePresence>

          <div className={`bg-white/10 backdrop-blur-2xl border border-white/20 rounded-[2rem] p-2 flex items-end gap-2 shadow-2xl transition-all ${isRecording ? 'opacity-50 pointer-events-none' : 'focus-within:bg-white-[0.12] focus-within:border-white/30'}`}>
            
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Спроси о чем-нибудь..."
              className="flex-1 bg-transparent text-white placeholder-white/40 border-none outline-none resize-none py-3 px-4 min-h-[52px] max-h-32 text-[17px] leading-relaxed"
              rows={1}
              style={{ fieldSizing: 'content' } as React.CSSProperties} // Modern auto-resize if supported
            />
            
            <div className="flex items-center gap-2 mb-1 mr-1">
              {/* Send Button */}
              {input.trim().length > 0 ? (
                <motion.button
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  onClick={handleSend}
                  className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center hover:bg-white/90 transition-colors shrink-0"
                >
                  <Send className="w-5 h-5 ml-[-2px]" />
                </motion.button>
              ) : (
                <motion.button
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="w-10 h-10 rounded-full border border-white/30 text-white/50 flex items-center justify-center transition-colors shrink-0 cursor-default"
                >
                  <Send className="w-4 h-4 ml-[-2px]" />
                </motion.button>
              )}
              
              {/* Plus / Video Button */}
              <button 
                onClick={startRecording}
                className="w-10 h-10 rounded-full border border-white/30 text-white/70 flex items-center justify-center hover:bg-white/20 hover:text-white transition-colors shrink-0 group"
                title="Записать кружок"
              >
                <Video className="w-4 h-4 group-hover:scale-110 transition-transform" />
              </button>
            </div>
            
          </div>
        </div>
      </div>
      
    </div>
  );
}
