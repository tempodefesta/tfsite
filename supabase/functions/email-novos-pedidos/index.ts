import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import nodemailer from "npm:nodemailer";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    const payload = await req.json();
    
    // Validate if it's an insert webkbook
    if (payload.type !== 'INSERT' || payload.table !== 'orcamentos') {
       return new Response(JSON.stringify({ error: "Invalid webhook trigger." }), { status: 400, headers: corsHeaders });
    }

    const { record } = payload;
    const orcamentoId = record.id;
    
    // Fetch items immediately (disparado pelo lado cliente aposta gravaçao)
    const { data: orcamentoItens, error } = await supabase
        .from('orcamento_itens')
        .select('quantidade, metadata')
        .eq('orcamento_id', orcamentoId);

    // SMTP Configuration
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: Deno.env.get("SMTP_USER"),
        pass: Deno.env.get("SMTP_PASS")
      }
    });

    // Build Email Template
    let itemsHTML = orcamentoItens.map(item => {
        const d = item.metadata || {};
        return `
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">
                    <img src="${d.img_url || ''}" width="50" style="border-radius: 8px;">
                </td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${d.nome || 'Produto sem nome'}</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantidade}x</td>
            </tr>
        `;
    }).join('');

    const eventDate = record.data_evento ? new Date(record.data_evento).toLocaleDateString('pt-BR') : 'Não especificada';
    const cleanWa = record.whatsapp ? record.whatsapp.replace(/\D/g, '') : '';
    const waLink = cleanWa ? `https://wa.me/${cleanWa}` : '#';

    const mailOptions = {
      from: '"Tempo de Festas" <' + Deno.env.get("SMTP_USER") + '>',
      to: 'atendimento@tempodefestas.com.br, maurocmj@gmail.com, tempodefestas@tempodefestas.com.br',
      subject: `🎉 Nova Cotação do Catálogo: ${record.nome_cliente}`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; max-w-xl; margin: 0 auto;">
            <h2 style="color: #48574B;">Nova Solicitação de Orçamento</h2>
            <p>Uma nova lista de produtos foi submetida pelo portal de vendas online.</p>
            
            <div style="background-color: #f4f6f5; padding: 15px; border-radius: 10px; margin-bottom: 20px;">
                <p><strong>Nome:</strong> ${record.nome_cliente}</p>
                <p><strong>Evento:</strong> ${eventDate}</p>
                <p><strong>WhatsApp:</strong> <a href="${waLink}">${record.whatsapp}</a></p>
            </div>

            <h3 style="color: #48574B;">Itens de Interesse (${orcamentoItens.length})</h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                ${itemsHTML || '<tr><td>Itens em processamento... acesse o Painel de Vendas.</td></tr>'}
            </table>

            <a href="${waLink}" style="background-color: #25D366; color: white; padding: 12px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
                Chamar Cliente no WhatsApp
            </a>
        </div>
      `
    };

    // Send Mail
    const info = await transporter.sendMail(mailOptions);

    return new Response(JSON.stringify({ success: true, messageId: info.messageId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
