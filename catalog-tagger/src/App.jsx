import { useState, useRef, useEffect } from 'react';
import ReactCrop from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { createClient } from '@supabase/supabase-js';
import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

function App() {
  const [currentPage, setCurrentPage] = useState(2);
  const [crop, setCrop] = useState();
  const [completedCrop, setCompletedCrop] = useState(null);
  
  const [productName, setProductName] = useState('');
  const [productTags, setProductTags] = useState('');
  const [productCategory, setProductCategory] = useState('');
  const [productValue, setProductValue] = useState('');
  
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);

  const imgRef = useRef(null);

  const totalPages = 30;

  // Load image blob so it's fresh? No, we can just use the import from parent thanks to Vite config.
  // Wait, directly setting src={/imagens_canva/${currentPage}.png} won't work perfectly in dev if the public dir is not serving it.
  // Actually, Vite doesn't serve `../...` using `/...`. We need to import it or use a proxy or serve static files.
  // The easiest way is to import it at runtime with a dynamic import, but since they are in a folder outside src, let's use a dynamic URL object or just fetch it.
  // Another way is to just put the images in `public/imagens_canva` for the duration of this task!
  // I will assume I can copy `../imagens_canva` to `./public/imagens_canva` for ease of use in the Vite app.

  const getCanvasBlob = (canvas) => {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/png', 1);
    });
  };

  const handleSave = async () => {
    if (!completedCrop || !completedCrop.width || !completedCrop.height) {
      alert('Selecione um produto primeiro!');
      return;
    }
    if (!productName.trim()) {
      alert('Digite o nome do produto!');
      return;
    }

    setIsSaving(true);
    setSaveStatus(null);

    try {
      // Create cropped image
      const canvas = document.createElement('canvas');
      const scaleX = imgRef.current.naturalWidth / imgRef.current.width;
      const scaleY = imgRef.current.naturalHeight / imgRef.current.height;
      const ctx = canvas.getContext('2d');
      const pixelRatio = window.devicePixelRatio;

      canvas.width = completedCrop.width * pixelRatio * scaleX;
      canvas.height = completedCrop.height * pixelRatio * scaleY;

      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      ctx.imageSmoothingQuality = 'high';

      // Draw exactly the cropped region
      ctx.drawImage(
        imgRef.current,
        completedCrop.x * scaleX,
        completedCrop.y * scaleY,
        completedCrop.width * scaleX,
        completedCrop.height * scaleY,
        0,
        0,
        completedCrop.width * scaleX,
        completedCrop.height * scaleY
      );

      const blob = await getCanvasBlob(canvas);

      const fileName = `pd_${Date.now()}.png`;

      // 1. Upload to Storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('catalogo')
        .upload(fileName, blob, { contentType: 'image/png' });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('catalogo')
        .getPublicUrl(fileName);

      // 2. Insert Product
      const { data: productData, error: productError } = await supabase
        .from('produtos')
        .insert([{ 
          nome: productName.trim(), 
          img_url: publicUrl,
          categoria: productCategory.trim() || null,
          valor: productValue.trim() || null
        }])
        .select()
        .single();

      if (productError) throw productError;

      // 3. Insert Tags
      const tagsArray = productTags.split(',').map(t => t.trim()).filter(Boolean);
      if (tagsArray.length > 0) {
        const tagsToInsert = tagsArray.map(tag => ({
          produto_id: productData.id,
          tag: tag.toLowerCase()
        }));
        
        const { error: tagError } = await supabase
          .from('tags')
          .insert(tagsToInsert);
          
        if (tagError) console.error("Erro inserindo tags:", tagError); // Not breaking if tags fail
      }

      setSaveStatus('success');
      setTimeout(() => setSaveStatus(null), 3000);
      
      // Reset form but keep tags/name roughly... Or clear it? 
      // Often better to clear it, ready for next product.
      setProductName('');
      setProductValue('');
      setCrop(null);
      setCompletedCrop(null);

    } catch (err) {
      console.error(err);
      alert('Erro ao salvar: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-100 p-8 flex flex-col font-sans">
      <header className="flex justify-between items-center mb-8 border-b border-neutral-800 pb-4">
        <h1 className="text-3xl font-bold bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
          Extrator Tempo de Festas
        </h1>
        <div className="flex items-center gap-4 bg-neutral-800 p-2 rounded-lg">
          <button 
            className="p-2 hover:bg-neutral-700 rounded-md disabled:opacity-50"
            onClick={() => setCurrentPage(c => Math.max(1, c - 1))}
            disabled={currentPage === 1}
          >
            <ChevronLeft size={20} />
          </button>
          <span className="font-semibold text-lg w-24 text-center">Página {currentPage} / {totalPages}</span>
          <button 
            className="p-2 hover:bg-neutral-700 rounded-md disabled:opacity-50"
            onClick={() => setCurrentPage(c => Math.min(totalPages, c + 1))}
            disabled={currentPage === totalPages}
          >
            <ChevronRight size={20} />
          </button>
        </div>
      </header>

      <main className="flex gap-8 flex-1 overflow-hidden">
        {/* Left: Image Viewer & Cropper */}
        <div className="flex-[3] bg-neutral-800 rounded-2xl overflow-hidden flex items-center justify-center border border-neutral-700 shadow-2xl relative">
          <div className="absolute top-4 left-4 z-10 bg-black/60 px-3 py-1 rounded text-sm text-amber-400 font-medium backdrop-blur-sm pointer-events-none">
            Arraste para selecionar o produto
          </div>
          
          <div className="w-full h-[calc(100vh-200px)] overflow-auto flex items-start justify-center p-4 custom-scrollbar">
             <ReactCrop
              crop={crop}
              onChange={c => setCrop(c)}
              onComplete={c => setCompletedCrop(c)}
              className="max-w-none"
            >
              {/* Note: src points to standard public path, see copy command below */}
              <img
                ref={imgRef}
                src={`/imagens_canva/${currentPage}.png`}
                alt={`Página ${currentPage}`}
                className="max-w-none shadow-2xl brightness-95"
                crossOrigin="anonymous"
                style={{ height: 'auto', maxHeight: 'none' }}
              />
            </ReactCrop>
          </div>
        </div>

        {/* Right: Tagging Form */}
        <div className="flex-1 bg-neutral-800 rounded-2xl p-6 border border-neutral-700 shadow-2xl flex flex-col gap-6">
          <h2 className="text-xl font-semibold border-b border-neutral-700 pb-2">Detalhes do Produto</h2>
          
          <div className="flex flex-col gap-2">
            <label className="text-sm text-neutral-400 font-medium">Nome do Produto</label>
            <input 
              type="text" 
              value={productName}
              onChange={e => setProductName(e.target.value)}
              className="px-4 py-3 bg-neutral-900 border border-neutral-700 rounded-lg focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all font-medium"
              placeholder="Ex: Cadeira Rústica X"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-neutral-400 font-medium">Categoria</label>
            <input 
              type="text" 
              value={productCategory}
              onChange={e => setProductCategory(e.target.value)}
              className="px-4 py-3 bg-neutral-900 border border-neutral-700 rounded-lg focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all font-medium"
              placeholder="Ex: Cadeiras, Móveis..."
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-neutral-400 font-medium">Valor (R$)</label>
            <input 
              type="text" 
              value={productValue}
              onChange={e => setProductValue(e.target.value)}
              className="px-4 py-3 bg-neutral-900 border border-neutral-700 rounded-lg focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all font-medium"
              placeholder="Ex: 15,90"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-neutral-400 font-medium">Tags de Estilo/Cor (separar por vírgula)</label>
            <textarea 
              value={productTags}
              onChange={e => setProductTags(e.target.value)}
              className="px-4 py-3 bg-neutral-900 border border-neutral-700 rounded-lg focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all text-sm h-32 resize-none custom-scrollbar"
              placeholder="Ex: madeira, rústico, chá revelação, marrom, cadeira..."
            />
          </div>

          <div className="mt-auto">
            {saveStatus === 'success' && (
              <div className="flex items-center gap-2 text-green-400 bg-green-400/10 p-3 rounded-lg mb-4 text-sm font-medium">
                <Check size={18} /> Produto salvo no Supabase!
              </div>
            )}
            
            <button 
              onClick={handleSave}
              disabled={isSaving}
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-4 rounded-xl shadow-lg transition-all"
            >
              {isSaving ? <Loader2 className="animate-spin" size={20} /> : "Salvar Produto & Cortar Próximo"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
